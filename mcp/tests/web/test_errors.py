"""Tests for the {error:{code,message}} envelope — spec §5.

Verifies that unhandled exceptions (routes raising RuntimeError, etc.)
return 500 JSON with the envelope instead of Starlette's plaintext response.
"""
import httpx
import pytest


@pytest.mark.asyncio
async def test_unhandled_exception_uses_envelope(app):
    @app.get("/_boom")
    async def _boom():
        raise RuntimeError("kaboom")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/_boom")

    assert r.status_code == 500
    body = r.json()
    assert body["error"]["code"] == "internal_error"
    # must NOT leak the exception message to the client
    assert "kaboom" not in r.text
