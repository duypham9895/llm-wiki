import pytest


@pytest.mark.asyncio
async def test_search_requires_prd_read(client_no_perms):
    r = await client_no_perms.get("/api/prd/search?q=referral")
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_library_requires_prd_read(client_no_perms):
    r = await client_no_perms.get("/api/prd/library")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_read_prd_requires_prd_read(client_no_perms):
    r = await client_no_perms.get("/api/prd/EP-1")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_search_returns_verdict_shape(client_prd_read, monkeypatch):
    import prd_mcp.web.prd as prdmod
    monkeypatch.setattr(prdmod, "search_prds_impl",
                        lambda cfg, store, llm, q, k: {"count": 1, "verdict": "match",
                                                       "results": [{"id": "EP-1", "title": "T", "score": 0.4}]})
    r = await client_prd_read.get("/api/prd/search?q=referral")
    assert r.status_code == 200
    body = r.json()
    assert body["verdict"] == "match" and body["count"] == 1


@pytest.mark.asyncio
async def test_read_unknown_id_404(client_prd_read, monkeypatch):
    import prd_mcp.web.prd as prdmod
    monkeypatch.setattr(prdmod, "read_prd_impl",
                        lambda cfg, prd_id: {"found": False, "id": prd_id, "body": ""})
    r = await client_prd_read.get("/api/prd/EP-999")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
