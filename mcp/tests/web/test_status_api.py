import pytest


@pytest.mark.asyncio
async def test_pipeline_reads_latest_run(client_status_view, monkeypatch):
    import prd_mcp.web.status as statusmod
    monkeypatch.setattr(statusmod, "read_latest_run",
                        lambda vault: {"run_id": "r1", "stages": {"sync": {"ok": True}},
                                       "halted": True, "halt_reason": "enrich 0/287", "halted_at": "enrich"})
    r = await client_status_view.get("/api/status/pipeline")
    assert r.status_code == 200
    assert r.json()["halted"] is True and r.json()["halt_reason"] == "enrich 0/287"


@pytest.mark.asyncio
async def test_pipeline_no_runs_is_friendly(client_status_view, monkeypatch):
    import prd_mcp.web.status as statusmod
    monkeypatch.setattr(statusmod, "read_latest_run", lambda vault: None)
    r = await client_status_view.get("/api/status/pipeline")
    assert r.status_code == 200 and r.json()["run_id"] is None


@pytest.mark.asyncio
async def test_status_requires_permission(client_prd_read):
    r = await client_prd_read.get("/api/status/pipeline")
    assert r.status_code == 403
