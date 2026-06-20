import pytest
from sqlalchemy import select

from prd_mcp.web import rbac
from prd_mcp.web.errors import AppError
from prd_mcp.web.models import User, Role, Permission


async def _get_or_create_perm(db, name: str) -> Permission:
    existing = (await db.execute(select(Permission).where(Permission.name == name))).scalar_one_or_none()
    if existing:
        return existing
    p = Permission(name=name)
    db.add(p)
    await db.flush()
    return p


async def _admin_role(db, role_name: str = "admin") -> Role:
    role = Role(name=role_name, is_system=True)
    for pn in ["users.manage", "roles.manage"]:
        role.permissions.append(await _get_or_create_perm(db, pn))
    db.add(role)
    await db.flush()
    return role


async def _active_admin(db, email) -> User:
    # each admin gets their own role object but reuses the same permission rows
    role = await _admin_role(db, role_name=f"admin_{email.split('@')[0]}")
    u = User(email=email, password_hash="x", status="active")
    u.roles.append(role)
    db.add(u)
    await db.flush()
    return u


async def test_invariant_holds_with_one_admin(db):
    await _active_admin(db, "admin@ringkas.co.id")
    await rbac.assert_admin_invariant(db)  # no raise


async def test_invariant_violated_with_zero_active_admins(db):
    u = await _active_admin(db, "admin@ringkas.co.id")
    u.status = "disabled"
    await db.flush()
    with pytest.raises(AppError) as e:
        await rbac.assert_admin_invariant(db)
    assert e.value.code == "last_admin"


async def test_invariant_counts_only_effective_pair_holders(db):
    # a user with only prd.read does not satisfy the invariant
    p = Permission(name="prd.read")
    db.add(p)
    await db.flush()
    role = Role(name="reader")
    role.permissions.append(p)
    u = User(email="r@ringkas.co.id", password_hash="x", status="active")
    u.roles.append(role)
    db.add(role)
    db.add(u)
    await db.flush()
    with pytest.raises(AppError):
        await rbac.assert_admin_invariant(db)


async def test_admin_invariant_takes_advisory_lock(db):
    """The check must acquire the xact advisory lock so concurrent disables of
    two different admins can't both pass (TOCTOU). We assert the lock is held by
    this transaction after the call (pg_advisory_xact_lock is recorded in
    pg_locks for the session's backend)."""
    from sqlalchemy import text

    await _active_admin(db, "a1@ringkas.co.id")
    await _active_admin(db, "a2@ringkas.co.id")
    await rbac.assert_admin_invariant(db)  # passes (2 admins) and takes the lock
    held = (await db.execute(text(
        "SELECT count(*) FROM pg_locks WHERE locktype='advisory' "
        "AND pid = pg_backend_pid()"
    ))).scalar_one()
    assert held >= 1
