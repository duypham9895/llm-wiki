async def _login_admin(client, settings):
    await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})


async def test_get_settings(client, settings):
    await _login_admin(client, settings)
    r = await client.get("/api/admin/settings")
    assert r.status_code == 200
    assert "registration_enabled" in r.json()
    assert "allowed_domains" in r.json()


async def test_update_settings_persists(client, settings):
    await _login_admin(client, settings)
    r = await client.put("/api/admin/settings", json={"registration_enabled": True, "allowed_domains": ["ringkas.co.id"]})
    assert r.status_code == 200
    g = await client.get("/api/admin/settings")
    assert g.json()["registration_enabled"] is True
    assert g.json()["allowed_domains"] == ["ringkas.co.id"]


async def test_settings_forbidden_for_member_without_roles_manage(app, settings, sessionmaker_):
    """A logged-in member (prd.read+prd.ask, no roles.manage) gets 403, not 401."""
    import httpx
    from sqlalchemy import select
    from prd_mcp.web.models import Role, User
    from prd_mcp.web.security import make_password_hasher

    hasher = make_password_hasher(settings)
    async with sessionmaker_() as s:
        member = (await s.execute(select(Role).where(Role.name == "member"))).scalar_one()
        u = User(email="memberonly@ringkas.co.id", password_hash=hasher.hash("member-pw-1234"), status="active")
        u.roles.append(member)
        s.add(u)
        await s.commit()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers={"X-Requested-With": "prd-app"}) as c:
        li = await c.post("/api/auth/login", json={"email": "memberonly@ringkas.co.id", "password": "member-pw-1234"})
        assert li.status_code == 200
        # member can NOT reach a roles.manage-guarded endpoint
        assert (await c.get("/api/admin/settings")).status_code == 403
        # ...nor a users.manage-guarded one
        assert (await c.get("/api/admin/users")).status_code == 403
