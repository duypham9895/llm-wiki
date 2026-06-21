import httpx
import pytest


@pytest.mark.asyncio
async def test_healthz_reports_db_ok(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/healthz")
        assert r.status_code == 200
        assert r.json()["db"] == "ok"
