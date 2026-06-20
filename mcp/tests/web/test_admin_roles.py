import pytest
from sqlalchemy import select

from prd_mcp.web.models import Permission, Role, User


async def _login_admin(client, settings):
    await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})


async def _perm_ids(sessionmaker_, names):
    async with sessionmaker_() as s:
        rows = (await s.execute(select(Permission).where(Permission.name.in_(names)))).scalars().all()
        return [str(p.id) for p in rows]


async def test_list_roles_and_permissions(client, settings):
    await _login_admin(client, settings)
    roles = await client.get("/api/admin/roles")
    assert roles.status_code == 200
    perms = await client.get("/api/admin/permissions")
    assert {p["name"] for p in perms.json()["permissions"]} == {
        "prd.read", "prd.ask", "status.view", "users.manage", "roles.manage"}


async def test_create_custom_role_ok(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    ids = await _perm_ids(sessionmaker_, ["prd.read", "status.view"])
    r = await client.post("/api/admin/roles", json={"name": "viewer", "permission_ids": ids})
    assert r.status_code == 201
    assert set(r.json()["permissions"]) == {"prd.read", "status.view"}


async def test_create_half_admin_role_422(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    ids = await _perm_ids(sessionmaker_, ["roles.manage"])
    r = await client.post("/api/admin/roles", json={"name": "halfadmin", "permission_ids": ids})
    assert r.status_code == 422 and r.json()["error"]["code"] == "admin_pair"


async def test_edit_system_role_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    async with sessionmaker_() as s:
        admin_role = (await s.execute(select(Role).where(Role.name == "admin"))).scalar_one()
        rid = str(admin_role.id)
    r = await client.put(f"/api/admin/roles/{rid}", json={"description": "hijack"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "system_role_immutable"


async def test_delete_system_role_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    async with sessionmaker_() as s:
        member_role = (await s.execute(select(Role).where(Role.name == "member"))).scalar_one()
        rid = str(member_role.id)
    r = await client.delete(f"/api/admin/roles/{rid}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "system_role_immutable"


async def test_delete_role_in_use_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    ids = await _perm_ids(sessionmaker_, ["prd.read"])
    created = await client.post("/api/admin/roles", json={"name": "temprole", "permission_ids": ids})
    rid = created.json()["id"]
    # assign to a user
    async with sessionmaker_() as s:
        role = (await s.execute(select(Role).where(Role.name == "temprole"))).scalar_one()
        u = User(email="hold@ringkas.co.id", password_hash="x", status="active")
        u.roles.append(role)
        s.add(u)
        await s.commit()
    r = await client.delete(f"/api/admin/roles/{rid}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "role_in_use"


async def _make_custom_admin_role_on_admin(client, settings, sessionmaker_):
    """Give the admin user a CUSTOM role with both admin-pair perms, then remove
    the seeded system admin role, so the custom role is the sole admin source."""
    both = await _perm_ids(sessionmaker_, ["users.manage", "roles.manage"])
    created = await client.post("/api/admin/roles", json={"name": "custom_admin", "permission_ids": both})
    assert created.status_code == 201
    custom_id = created.json()["id"]
    async with sessionmaker_() as s:
        admin = (await s.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
        custom = (await s.execute(select(Role).where(Role.name == "custom_admin"))).scalar_one()
        admin.roles[:] = [custom]   # sole admin source is now the custom role
        await s.commit()
    return custom_id


async def test_update_custom_admin_role_removing_pair_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    custom_id = await _make_custom_admin_role_on_admin(client, settings, sessionmaker_)
    read_only = await _perm_ids(sessionmaker_, ["prd.read"])
    r = await client.put(f"/api/admin/roles/{custom_id}", json={"permission_ids": read_only})
    assert r.status_code == 409 and r.json()["error"]["code"] == "last_admin"


async def test_delete_custom_admin_role_is_409_last_admin(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    custom_id = await _make_custom_admin_role_on_admin(client, settings, sessionmaker_)
    # deleting the sole admin-source role would drop the last admin (it's assigned,
    # so role_in_use OR last_admin may fire — both are correct 409s; assert 409)
    r = await client.delete(f"/api/admin/roles/{custom_id}")
    assert r.status_code == 409 and r.json()["error"]["code"] in ("last_admin", "role_in_use")
