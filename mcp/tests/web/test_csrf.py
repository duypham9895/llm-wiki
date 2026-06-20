import httpx
import pytest


@pytest.mark.asyncio
async def test_post_without_csrf_header_is_403(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        # no X-Requested-With header
        r = await c.post("/api/auth/login", json={"email": "a@b.co", "password": "x" * 12})
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "csrf"


@pytest.mark.asyncio
async def test_get_does_not_require_csrf(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/healthz")
        assert r.status_code in (200, 503)  # no CSRF on GET


@pytest.mark.asyncio
async def test_post_with_csrf_header_passes_csrf_gate(app, settings):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers={"X-Requested-With": "prd-app"}) as c:
        r = await c.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
        assert r.status_code == 200  # passed CSRF (and login succeeded)
