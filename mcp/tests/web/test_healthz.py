import httpx
import pytest

from prd_mcp.web.app import create_app


@pytest.mark.asyncio
async def test_healthz_reports_db_ok(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/healthz")
        assert r.status_code == 200
        assert r.json()["db"] == "ok"


@pytest.mark.asyncio
async def test_hsts_header_present_in_prod(settings, sessionmaker_):
    prod_app = create_app(settings.model_copy(update={"env": "prod"}), sessionmaker_, run_startup=False)
    transport = httpx.ASGITransport(app=prod_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/healthz")
    assert "strict-transport-security" in {k.lower() for k in r.headers}


@pytest.mark.asyncio
async def test_hsts_header_absent_in_dev(settings, sessionmaker_):
    dev_app = create_app(settings.model_copy(update={"env": "dev"}), sessionmaker_, run_startup=False)
    transport = httpx.ASGITransport(app=dev_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/healthz")
    assert "strict-transport-security" not in {k.lower() for k in r.headers}
