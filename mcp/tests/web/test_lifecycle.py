import httpx
import pytest
from sqlalchemy import select, update

from prd_mcp.web.models import AppSettings, Role, User


@pytest.mark.asyncio
async def test_full_lifecycle_register_approve_login_access_disable(app, settings, sessionmaker_):
    """register → admin approve → login → access guarded route → admin disable → 401."""
    transport = httpx.ASGITransport(app=app)
    H = {"X-Requested-With": "prd-app"}

    # enable registration for ringkas.co.id
    async with sessionmaker_() as s:
        await s.execute(update(AppSettings).values(registration_enabled=True, allowed_domains=["ringkas.co.id"]))
        await s.commit()

    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=H) as admin:
        await admin.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})

        # 1. self-register
        async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=H) as anon:
            reg = await anon.post("/api/auth/register", json={"email": "alice@ringkas.co.id", "password": "alice-pw-1234"})
            assert reg.status_code == 202

        # 2. admin approves alice as member
        async with sessionmaker_() as s:
            alice = (await s.execute(select(User).where(User.email == "alice@ringkas.co.id"))).scalar_one()
            member = (await s.execute(select(Role).where(Role.name == "member"))).scalar_one()
            alice_id, member_id = str(alice.id), str(member.id)
        appr = await admin.post(f"/api/admin/users/{alice_id}/approve", json={"role_ids": [member_id]})
        assert appr.status_code == 200 and appr.json()["status"] == "active"

        # 3. alice logs in and reads her profile
        async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=H) as alice_c:
            li = await alice_c.post("/api/auth/login", json={"email": "alice@ringkas.co.id", "password": "alice-pw-1234"})
            assert li.status_code == 200
            me = await alice_c.get("/api/auth/me")
            assert "prd.read" in me.json()["permissions"]
            # alice cannot reach admin endpoints
            assert (await alice_c.get("/api/admin/users")).status_code == 403

            # 4. admin disables alice -> her next request is 401 + cookie cleared
            dis = await admin.post(f"/api/admin/users/{alice_id}/disable")
            assert dis.status_code == 200
            assert (await alice_c.get("/api/auth/me")).status_code == 401
