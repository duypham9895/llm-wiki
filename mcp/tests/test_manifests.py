import json
import os
import tempfile
from prd_mcp.web.manifests import read_latest_run, read_run_history


def _write(vault, run_id, stage, ok=True):
    d = os.path.join(vault, ".runs", run_id)
    os.makedirs(d, exist_ok=True)
    json.dump({"stage": stage, "run_id": run_id, "ok": ok, "exit_code": 0 if ok else 1,
               "counts": {"processed": 1, "succeeded": 1, "failed": 0, "skipped": 0},
               "errors": [], "started_at": "a", "finished_at": "b"},
              open(os.path.join(d, f"{stage}.json"), "w"))


def test_no_runs_dir_returns_none_and_empty():
    with tempfile.TemporaryDirectory() as vault:
        assert read_latest_run(vault) is None
        assert read_run_history(vault) == []


def test_latest_run_picks_newest_and_collects_stages():
    with tempfile.TemporaryDirectory() as vault:
        for s in ("sync", "enrich", "index"):
            _write(vault, "2026-06-19T03:00:00Z", s)
        _write(vault, "2026-06-20T03:00:00Z", "sync")
        _write(vault, "2026-06-20T03:00:00Z", "enrich")
        latest = read_latest_run(vault)
        assert latest["run_id"] == "2026-06-20T03:00:00Z"
        assert set(latest["stages"]) == {"sync", "enrich"}  # index missing -> halted inferred
        assert latest["halted"] is True


def test_history_newest_first_limited():
    with tempfile.TemporaryDirectory() as vault:
        for day in ("18", "19", "20"):
            _write(vault, f"2026-06-{day}T03:00:00Z", "sync")
        hist = read_run_history(vault, limit=2)
        assert [h["run_id"] for h in hist] == ["2026-06-20T03:00:00Z", "2026-06-19T03:00:00Z"]


def test_summary_halt_reason_round_trips_from_extra():
    # Codex #5: orchestrator writes halt fields under extra; reader must surface them.
    with tempfile.TemporaryDirectory() as vault:
        rid = "2026-06-20T03:00:00Z"
        _write(vault, rid, "sync")
        _write(vault, rid, "enrich", ok=False)
        d = os.path.join(vault, ".runs", rid)
        json.dump({"stage": "summary", "run_id": rid, "ok": False, "exit_code": 1,
                   "counts": {"processed": 0, "succeeded": 0, "failed": 0, "skipped": 0}, "errors": [],
                   "extra": {"halted": True, "halt_reason": "enrich 0/287 (ratio 0.00 < 0.5)", "halted_at": "enrich"}},
                  open(os.path.join(d, "summary.json"), "w"))
        latest = read_latest_run(vault)
        assert latest["halted"] is True
        assert latest["halt_reason"] == "enrich 0/287 (ratio 0.00 < 0.5)"
        assert latest["halted_at"] == "enrich"
