"""Admin router: users (users.manage), roles + settings (roles.manage).

Every privilege-reducing path calls assert_admin_invariant inside the txn;
every role/user perm assignment calls assert_pair_integrity FIRST (422 before 409).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from prd_mcp.web import sessions as sessions_mod
from prd_mcp.web.db import get_db
from prd_mcp.web.errors import (
    AppError,
    role_in_use_error,
    system_role_error,
)
from prd_mcp.web.models import Permission, Role, User, AppSettings
from prd_mcp.web.rbac import (
    assert_admin_invariant,
    assert_pair_integrity,
    effective_permissions,
    require_permission,
)
from prd_mcp.web.schemas import (
    ApproveIn,
    PermissionOut,
    RoleCreateIn,
    RoleOut,
    RoleUpdateIn,
    SetPasswordIn,
    SetRolesIn,
    SettingsIn,
    SettingsOut,
    UserOut,
)
from prd_mcp.web.auth import user_to_out

router = APIRouter(prefix="/api/admin")


def role_to_out(role: Role) -> RoleOut:
    return RoleOut(
        id=role.id, name=role.name, description=role.description,
        is_system=role.is_system, permissions=sorted(p.name for p in role.permissions),
    )


async def _user_or_404(db, user_id: uuid.UUID) -> User:
    u = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if u is None:
        raise AppError(404, "not_found", "user not found")
    return u


async def _roles_or_404(db, role_ids: list[uuid.UUID]) -> list[Role]:
    if not role_ids:
        return []
    rows = (await db.execute(select(Role).where(Role.id.in_(role_ids)))).scalars().all()
    if len(rows) != len(set(role_ids)):
        raise AppError(404, "not_found", "one or more roles not found")
    return rows


def _union_perm_names(roles: list[Role]) -> set[str]:
    return {p.name for r in roles for p in r.permissions}


# ---- users (require users.manage) ----

@router.get("/users", dependencies=[Depends(require_permission("users.manage"))])
async def list_users(
    db=Depends(get_db),
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    base = select(User)
    if status:
        base = base.where(User.status == status)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    rows = (await db.execute(base.order_by(User.created_at).limit(limit).offset(offset))).scalars().all()
    return {
        "users": [user_to_out(u).model_dump(mode="json") for u in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/users/{user_id}", dependencies=[Depends(require_permission("users.manage"))])
async def get_user(user_id: uuid.UUID, db=Depends(get_db)):
    return user_to_out(await _user_or_404(db, user_id)).model_dump(mode="json")


@router.post("/users/{user_id}/approve")
async def approve_user(
    user_id: uuid.UUID,
    payload: ApproveIn,
    db=Depends(get_db),
    actor: User = Depends(require_permission("users.manage")),
):
    user = await _user_or_404(db, user_id)
    # approve is pending->active ONLY. Without this guard, approving an ACTIVE
    # last-admin with non-admin roles would strip their admin perms while skipping
    # the last-admin check (approve isn't in that guarded set) -> lockout.
    if user.status != "pending":
        raise AppError(409, "invalid_state", "only pending users can be approved")
    roles = await _roles_or_404(db, payload.role_ids)
    assert_pair_integrity(_union_perm_names(roles))  # 422 before any state change
    user.status = "active"
    user.approved_at = datetime.now(timezone.utc)
    user.approved_by = actor.id  # spec §4: approver recorded
    user.roles[:] = roles
    await db.commit()  # get_db only yields; without commit the approval rolls back
    await db.refresh(user)
    return user_to_out(user).model_dump(mode="json")


@router.post("/users/{user_id}/disable", dependencies=[Depends(require_permission("users.manage"))])
async def disable_user(user_id: uuid.UUID, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    user.status = "disabled"
    await db.flush()
    await assert_admin_invariant(db)  # 409 + rollback if this drops the last admin
    await sessions_mod.revoke_user_sessions(db, user.id)
    await db.commit()
    await db.refresh(user)
    return user_to_out(user).model_dump(mode="json")


@router.post("/users/{user_id}/enable", dependencies=[Depends(require_permission("users.manage"))])
async def enable_user(user_id: uuid.UUID, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    # enable is disabled->active ONLY. A pending user must go through approve
    # (which sets approved_at/by + assigns roles); enabling one would skip that.
    if user.status != "disabled":
        raise AppError(409, "invalid_state", "only disabled users can be enabled")
    # Re-activating must not produce a half-admin: if the disabled user's effective
    # perms hold exactly one of the admin pair, reactivating them would violate
    # pair-integrity (which only the request layer enforces). Check before activating.
    assert_pair_integrity(effective_permissions(user))  # 422 if half-admin
    user.status = "active"
    await db.commit()
    await db.refresh(user)
    return user_to_out(user).model_dump(mode="json")


@router.post("/users/{user_id}/reject", dependencies=[Depends(require_permission("users.manage"))])
async def reject_user(user_id: uuid.UUID, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    # reject is pending->deleted ONLY (spec §5). Guard so it can't become a
    # backdoor delete path for active users that skips delete_user's semantics.
    if user.status != "pending":
        raise AppError(409, "invalid_state", "only pending users can be rejected")
    await db.delete(user)
    await db.commit()
    return {"status": "rejected"}


@router.post("/users/{user_id}/reset-password", dependencies=[Depends(require_permission("users.manage"))])
async def reset_password(user_id: uuid.UUID, payload: SetPasswordIn, request: Request, db=Depends(get_db)):
    settings = request.app.state.settings
    from prd_mcp.web.schemas import validate_password

    validate_password(payload.password, settings)
    user = await _user_or_404(db, user_id)
    user.password_hash = request.app.state.password_hasher.hash(payload.password)
    await sessions_mod.revoke_user_sessions(db, user.id)
    await db.commit()
    return {"status": "ok"}


@router.put("/users/{user_id}/roles", dependencies=[Depends(require_permission("users.manage"))])
async def set_user_roles(user_id: uuid.UUID, payload: SetRolesIn, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    roles = await _roles_or_404(db, payload.role_ids)
    assert_pair_integrity(_union_perm_names(roles))  # 422 first
    user.roles[:] = roles
    await db.flush()
    await assert_admin_invariant(db)  # 409 second
    await sessions_mod.revoke_user_sessions(db, user.id)
    await db.commit()
    await db.refresh(user)
    return user_to_out(user).model_dump(mode="json")


@router.delete("/users/{user_id}", dependencies=[Depends(require_permission("users.manage"))])
async def delete_user(user_id: uuid.UUID, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    await db.delete(user)
    await db.flush()
    await assert_admin_invariant(db)
    await db.commit()
    return {"status": "deleted"}


# ---- roles + settings (require roles.manage) ----

@router.get("/roles", dependencies=[Depends(require_permission("roles.manage"))])
async def list_roles(db=Depends(get_db)):
    roles = (await db.execute(select(Role))).scalars().all()
    return {"roles": [role_to_out(r).model_dump(mode="json") for r in roles]}


@router.get("/permissions", dependencies=[Depends(require_permission("roles.manage"))])
async def list_permissions(db=Depends(get_db)):
    perms = (await db.execute(select(Permission))).scalars().all()
    return {"permissions": [PermissionOut(name=p.name, description=p.description).model_dump() for p in perms]}


@router.post("/roles", status_code=201, dependencies=[Depends(require_permission("roles.manage"))])
async def create_role(payload: RoleCreateIn, db=Depends(get_db)):
    perms = (await db.execute(select(Permission).where(Permission.id.in_(payload.permission_ids)))).scalars().all()
    if len(perms) != len(set(payload.permission_ids)):
        raise AppError(404, "not_found", "one or more permissions not found")
    assert_pair_integrity({p.name for p in perms})  # 422
    role = Role(name=payload.name, description=payload.description, is_system=False)
    role.permissions[:] = perms
    db.add(role)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise AppError(409, "role_exists", "a role with that name already exists")
    await db.refresh(role)
    return role_to_out(role).model_dump(mode="json")


@router.put("/roles/{role_id}", dependencies=[Depends(require_permission("roles.manage"))])
async def update_role(role_id: uuid.UUID, payload: RoleUpdateIn, db=Depends(get_db)):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if role is None:
        raise AppError(404, "not_found", "role not found")
    if role.is_system:
        raise system_role_error()  # 409, fully immutable
    if payload.name is not None:
        role.name = payload.name
    if payload.description is not None:
        role.description = payload.description
    if payload.permission_ids is not None:
        perms = (await db.execute(select(Permission).where(Permission.id.in_(payload.permission_ids)))).scalars().all()
        if len(perms) != len(set(payload.permission_ids)):
            raise AppError(404, "not_found", "one or more permissions not found")
        assert_pair_integrity({p.name for p in perms})  # 422
        role.permissions[:] = perms
    await db.flush()
    await assert_admin_invariant(db)  # 409 if a perm removal drops the last admin
    await db.commit()
    await db.refresh(role)
    return role_to_out(role).model_dump(mode="json")


@router.delete("/roles/{role_id}", dependencies=[Depends(require_permission("roles.manage"))])
async def delete_role(role_id: uuid.UUID, db=Depends(get_db)):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if role is None:
        raise AppError(404, "not_found", "role not found")
    if role.is_system:
        raise system_role_error()
    await db.delete(role)
    try:
        await db.flush()
        await assert_admin_invariant(db)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise role_in_use_error()  # FK RESTRICT
    return {"status": "deleted"}


@router.get("/settings", dependencies=[Depends(require_permission("roles.manage"))])
async def get_settings_endpoint(db=Depends(get_db)):
    row = (await db.execute(select(AppSettings))).scalar_one_or_none()
    if row is None:
        return SettingsOut(registration_enabled=False, allowed_domains=[]).model_dump()
    return SettingsOut(registration_enabled=row.registration_enabled, allowed_domains=list(row.allowed_domains)).model_dump()


@router.put("/settings", dependencies=[Depends(require_permission("roles.manage"))])
async def update_settings_endpoint(payload: SettingsIn, request: Request, db=Depends(get_db)):
    row = (await db.execute(select(AppSettings))).scalar_one_or_none()
    domains = [d.strip().lower() for d in payload.allowed_domains if d.strip()]
    actor = getattr(request.state, "current_user", None)
    if row is None:
        row = AppSettings(id=1, registration_enabled=payload.registration_enabled, allowed_domains=domains)
        db.add(row)
    else:
        row.registration_enabled = payload.registration_enabled
        row.allowed_domains = domains
        row.updated_at = datetime.now(timezone.utc)
    if actor is not None:
        row.updated_by = actor.id
    await db.commit()
    await db.refresh(row)
    return SettingsOut(registration_enabled=row.registration_enabled, allowed_domains=list(row.allowed_domains)).model_dump()
