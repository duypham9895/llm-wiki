import pytest

from prd_mcp.web import rbac
from prd_mcp.web.errors import AppError
from prd_mcp.web.models import User, Role, Permission


async def _perm(db, name) -> Permission:
    p = Permission(name=name)
    db.add(p)
    await db.flush()
    return p


async def _role(db, name, perm_names, is_system=False) -> Role:
    role = Role(name=name, is_system=is_system)
    for pn in perm_names:
        role.permissions.append(await _perm(db, pn))
    db.add(role)
    await db.flush()
    return role


def test_permissions_vocabulary_is_exactly_five():
    assert set(rbac.PERMISSIONS) == {"prd.read", "prd.ask", "status.view", "users.manage", "roles.manage"}


def test_assert_pair_integrity_rejects_exactly_one():
    with pytest.raises(AppError) as e:
        rbac.assert_pair_integrity({"roles.manage", "prd.read"})
    assert e.value.code == "admin_pair"
    with pytest.raises(AppError):
        rbac.assert_pair_integrity({"users.manage"})


def test_assert_pair_integrity_allows_both_or_neither():
    rbac.assert_pair_integrity({"users.manage", "roles.manage"})  # both
    rbac.assert_pair_integrity({"prd.read", "prd.ask"})  # neither
    rbac.assert_pair_integrity(set())  # empty


async def test_effective_permissions_is_union(db):
    role_a = await _role(db, "a", ["prd.read"])
    role_b = await _role(db, "b", ["prd.ask", "status.view"])
    u = User(email="u@ringkas.co.id", password_hash="x", status="active")
    u.roles.extend([role_a, role_b])
    db.add(u)
    await db.commit()
    await db.refresh(u)
    assert rbac.effective_permissions(u) == {"prd.read", "prd.ask", "status.view"}


async def test_no_roles_no_permissions(db):
    u = User(email="z@ringkas.co.id", password_hash="x", status="active")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    assert rbac.effective_permissions(u) == set()
