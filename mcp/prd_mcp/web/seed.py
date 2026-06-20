"""Idempotent boot seeding + the startup integrity guard.

Order on every boot: permissions -> system roles (re-asserted) -> app_settings
(first-boot only) -> break-glass admin (only when no active admin-equivalent) ->
assert_global_pair_integrity.
"""
from __future__ import annotations

from sqlalchemy import select

from prd_mcp.web import rbac
from prd_mcp.web.models import AppSettings, Permission, Role, User
from prd_mcp.web.security import make_password_hasher
from prd_mcp.web.settings import WebSettings


async def seed_permissions(db) -> None:
    existing = {p.name: p for p in (await db.execute(select(Permission))).scalars().all()}
    for name, desc in rbac.PERMISSIONS.items():
        p = existing.get(name)
        if p is None:
            db.add(Permission(name=name, description=desc))
        elif p.description != desc:
            p.description = desc
    await db.flush()


async def _perms_by_name(db) -> dict[str, Permission]:
    return {p.name: p for p in (await db.execute(select(Permission))).scalars().all()}


async def seed_system_roles(db) -> None:
    perms = await _perms_by_name(db)
    wanted = {
        "admin": set(rbac.ALL_PERMISSION_NAMES),
        "member": set(rbac.MEMBER_PERMISSION_NAMES),
    }
    roles = {r.name: r for r in (await db.execute(select(Role))).scalars().all()}
    for name, perm_names in wanted.items():
        role = roles.get(name)
        if role is None:
            role = Role(name=name, is_system=True)
            db.add(role)
        role.is_system = True
        # re-assert the exact permission set every boot (drift defense)
        role.permissions[:] = [perms[pn] for pn in perm_names]
    await db.flush()


async def _active_admin_equivalents(db) -> list[User]:
    users = (await db.execute(select(User).where(User.status == "active"))).scalars().all()
    return [u for u in users if rbac.ADMIN_PAIR <= rbac.effective_permissions(u)]


async def seed_bootstrap_admin(db, settings: WebSettings) -> None:
    if await _active_admin_equivalents(db):
        return  # healthy instance — never touch existing admins
    hasher = make_password_hasher(settings)
    admin_role = (await db.execute(select(Role).where(Role.name == "admin"))).scalar_one()
    user = (await db.execute(select(User).where(User.email == settings.admin_email))).scalar_one_or_none()
    if user is None:
        user = User(
            email=settings.admin_email,
            password_hash=hasher.hash(settings.admin_password),
            status="active",
        )
        user.roles.append(admin_role)
        db.add(user)
    else:
        # Break-glass recovery: we only reach this branch when NO active admin
        # exists, so restore a KNOWN-GOOD credential from .env — reactivate AND
        # reset the password to argon2(ADMIN_PASSWORD) (spec §4). The "never reset
        # a healthy admin" guarantee is upheld by the early return above: a healthy
        # instance never enters seed_bootstrap_admin's mutation path at all.
        user.status = "active"
        user.password_hash = hasher.hash(settings.admin_password)
        if admin_role not in user.roles:
            user.roles.append(admin_role)
    await db.flush()


async def seed_app_settings(db, settings: WebSettings) -> None:
    """Create the singleton app_settings row from env on FIRST boot only.

    If the row already exists, leave it untouched — the DB is authoritative after
    first boot, so an admin's runtime toggle is never reverted by a redeploy.
    """
    existing = (await db.execute(select(AppSettings))).scalar_one_or_none()
    if existing is not None:
        return
    db.add(
        AppSettings(
            id=1,
            registration_enabled=settings.registration_enabled,
            allowed_domains=settings.allowed_domains_seed,
        )
    )
    await db.flush()


async def assert_global_pair_integrity(db) -> None:
    # every role's own permission set
    roles = (await db.execute(select(Role))).scalars().all()
    for role in roles:
        names = {p.name for p in role.permissions}
        if len(names & rbac.ADMIN_PAIR) == 1:
            raise RuntimeError(f"half-admin role detected: {role.name} holds exactly one of {set(rbac.ADMIN_PAIR)}")
    # every active user's effective union
    users = (await db.execute(select(User).where(User.status == "active"))).scalars().all()
    for u in users:
        eff = rbac.effective_permissions(u)
        if len(eff & rbac.ADMIN_PAIR) == 1:
            raise RuntimeError(f"half-admin user detected: {u.email} effectively holds exactly one of {set(rbac.ADMIN_PAIR)}")


async def run_seed(db, settings: WebSettings) -> None:
    await seed_permissions(db)
    await seed_system_roles(db)
    await seed_app_settings(db, settings)
    await seed_bootstrap_admin(db, settings)
    await assert_global_pair_integrity(db)
    await db.commit()
