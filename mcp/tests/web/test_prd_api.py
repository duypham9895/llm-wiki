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


@pytest.mark.asyncio
async def test_recent_records_viewed_prds(client_prd_read, monkeypatch):
    """GET /api/prd/{id} on a found PRD must record the view; /recent must
    return them newest-first."""
    import prd_mcp.web.prd as prdmod
    monkeypatch.setattr(prdmod, "read_prd_impl",
                        lambda cfg, prd_id: {"found": True, "id": prd_id, "body": "x"})

    # Open EP-A then EP-B; recent must list B first.
    assert (await client_prd_read.get("/api/prd/EP-A")).status_code == 200
    assert (await client_prd_read.get("/api/prd/EP-B")).status_code == 200

    r = await client_prd_read.get("/api/prd/recent?limit=8")
    assert r.status_code == 200
    ids = [row["id"] for row in r.json()["results"]]
    assert ids[0] == "EP-B"
    assert ids[1] == "EP-A"


@pytest.mark.asyncio
async def test_recent_does_not_record_404(client_prd_read, monkeypatch):
    """A 404 read must NOT pollute the recents list."""
    import prd_mcp.web.prd as prdmod
    monkeypatch.setattr(prdmod, "read_prd_impl",
                        lambda cfg, prd_id: {"found": False, "id": prd_id, "body": ""})

    await client_prd_read.get("/api/prd/EP-MISSING")
    r = await client_prd_read.get("/api/prd/recent?limit=8")
    assert r.json()["results"] == []


@pytest.mark.asyncio
async def test_recent_requires_prd_read(client_no_perms):
    r = await client_no_perms.get("/api/prd/recent")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_recent_is_per_user(client_prd_ask, client_prd_read, monkeypatch):
    """Two users' recent lists are isolated."""
    import prd_mcp.web.prd as prdmod
    monkeypatch.setattr(prdmod, "read_prd_impl",
                        lambda cfg, prd_id: {"found": True, "id": prd_id, "body": "x"})

    # ask_user opens EP-A; reader opens EP-B. Each should see only their own.
    assert (await client_prd_ask.get("/api/prd/EP-A")).status_code == 200
    assert (await client_prd_read.get("/api/prd/EP-B")).status_code == 200

    ask_recent = (await client_prd_ask.get("/api/prd/recent?limit=8")).json()["results"]
    read_recent = (await client_prd_read.get("/api/prd/recent?limit=8")).json()["results"]
    assert [r["id"] for r in ask_recent] == ["EP-A"]
    assert [r["id"] for r in read_recent] == ["EP-B"]
