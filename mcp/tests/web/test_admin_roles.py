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
