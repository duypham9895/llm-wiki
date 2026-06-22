"""A↔B cross-plan, cross-language manifest contract test (integration).

Plan B (Node + Python) WRITES run-manifests to <vault>/.runs/<run_id>/<stage>.json.
Plan A's Status API READS them via prd_mcp.web.manifests.read_latest_run /
read_run_history. Every unit test on both sides uses fakes; THIS test exercises
the real seam: a Node process (tsx test/crossplan-emit.ts) writes manifests with
the production `writeManifest` + the orchestrator's real summary shape, then the
Python reader consumes them and we assert the contract holds across the language
boundary.

Marked `integration` (needs Node/tsx available). If tsx/npx is absent the test
skips rather than failing — it's an environment capability, not a code defect.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import pathlib

import pytest

from prd_mcp.web.manifests import read_latest_run, read_run_history

# repo root = .../llm-wiki ; this file is at mcp/tests/web/
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_EMITTER = _REPO_ROOT / "test" / "crossplan-emit.ts"


def _emit(vault: str, scenario: str) -> dict:
    """Run the Node emitter to write real manifests into <vault>/.runs/. Returns its JSON.

    Launches via `node --import tsx` rather than `npx tsx`: npx's IPC helper hits
    EPERM under some sandboxed environments (Codex audit #3), whereas the loader
    form runs node directly and is portable.
    """
    node = shutil.which("node")
    if node is None or not _EMITTER.exists():
        pytest.skip("node or the emitter script unavailable — Node toolchain required")
    proc = subprocess.run(
        [node, "--import", "tsx", str(_EMITTER), vault, scenario],
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        pytest.fail(f"emitter failed ({proc.returncode}):\nstdout={proc.stdout}\nstderr={proc.stderr}")
    # Last stdout line is the JSON run-id record.
    last = [ln for ln in proc.stdout.splitlines() if ln.strip()][-1]
    return json.loads(last)


@pytest.mark.integration
def test_healthy_run_round_trips_ts_to_python():
    """TS writes a healthy 3-stage run + summary; Python read_latest_run reads it
    with the correct newest-first run_id, all stages present, not halted."""
    with tempfile.TemporaryDirectory() as vault:
        meta = _emit(vault, "healthy")
        latest = read_latest_run(vault)
        assert latest is not None, "read_latest_run returned None for a written run"
        # newest-first: the 2026-06-21 run wins over the 2026-06-20 run
        assert latest["run_id"] == meta["newRun"]
        assert set(latest["stages"]) == {"sync", "enrich", "index"}, "all 3 stages should be readable"
        assert latest["halted"] is False
        assert latest["halt_reason"] is None
        # the TS-written counts survive the round-trip with correct field names
        assert latest["stages"]["enrich"]["counts"]["succeeded"] == 5
        assert latest["stages"]["index"]["extra"]["index_nonempty"] is True


@pytest.mark.integration
def test_halted_run_round_trips_with_halt_fields_from_extra():
    """The 287/287 incident shape: TS writes sync ok, enrich FAILED, no index, and a
    summary with halt fields under `extra`. Python must surface halted/halt_reason/
    halted_at read from summary.extra (the Codex-#5 nesting contract)."""
    with tempfile.TemporaryDirectory() as vault:
        meta = _emit(vault, "halted")
        latest = read_latest_run(vault)
        assert latest is not None
        assert latest["run_id"] == meta["newRun"]
        # index never ran → only sync + enrich present
        assert set(latest["stages"]) == {"sync", "enrich"}
        # halt fields come from summary.extra written by the TS orchestrator
        assert latest["halted"] is True
        assert latest["halt_reason"] == "enrich 0/287 (ratio 0.00 < 0.5)"
        assert latest["halted_at"] == "enrich"
        # enrich manifest honestly reports the failure across the boundary
        assert latest["stages"]["enrich"]["ok"] is False
        assert latest["stages"]["enrich"]["counts"]["failed"] == 287
        # read_run_history must AGREE with read_latest_run that this run is NOT ok
        # (Codex audit #1: history was reporting ok=True for halted partial runs).
        hist = read_run_history(vault, limit=10)
        halted_entry = next(h for h in hist if h["run_id"] == meta["newRun"])
        assert halted_entry["ok"] is False, "history disagreed with latest: halted run shown as ok"


@pytest.mark.integration
def test_run_history_orders_newest_first_across_runs():
    """read_run_history sees BOTH the older and newer TS-written runs, newest first."""
    with tempfile.TemporaryDirectory() as vault:
        meta = _emit(vault, "healthy")
        hist = read_run_history(vault, limit=10)
        assert [h["run_id"] for h in hist] == [meta["newRun"], meta["olderRun"]]
        # both healthy runs report ok=True with all stages counted
        assert all(h["ok"] for h in hist)
        assert hist[0]["stage_count"] == 3


def test_python_written_index_manifest_reads_back():
    """In production the INDEX stage manifest is written by PYTHON (write_index_manifest),
    while sync/enrich/summary are written by Node. ONE reader (read_latest_run) reads all
    four — so the Python-written index.json must be read-back-compatible (Codex audit #4).
    No Node needed here: write the index manifest with the production Python writer + a
    Python-written sync stage, then read it back."""
    from prd_mcp.web.manifests import write_index_manifest, _read_stage

    with tempfile.TemporaryDirectory() as vault:
        run_id = "2026-06-21T09:00:00Z"
        # Production Python index writer (the same call cli.py makes after run_index).
        write_index_manifest(
            vault, run_id, run_id, run_id,
            {"indexed": 5, "skipped": 282, "removed": 0, "errors": 0},
            index_nonempty=True,
        )
        # Minimal sibling stages so read_latest_run sees a populated run.
        import json, os
        d = os.path.join(vault, ".runs", run_id)
        for s in ("sync", "enrich"):
            with open(os.path.join(d, f"{s}.json"), "w") as fh:
                json.dump({"stage": s, "run_id": run_id, "ok": True, "exit_code": 0,
                           "counts": {"processed": 1, "succeeded": 1, "failed": 0, "skipped": 0},
                           "errors": [], "started_at": run_id, "finished_at": run_id}, fh)

        latest = read_latest_run(vault)
        assert latest is not None and latest["run_id"] == run_id
        # The Python-written index manifest is read back with the expected fields.
        idx = latest["stages"]["index"]
        assert idx["stage"] == "index"
        assert idx["ok"] is True and idx["exit_code"] == 0
        assert idx["counts"] == {"processed": 5, "succeeded": 5, "failed": 0, "skipped": 282}
        assert idx["extra"]["index_nonempty"] is True
        # An all-ok run with all 3 stages → history ok=True.
        hist = read_run_history(vault, limit=10)
        assert hist[0]["run_id"] == run_id and hist[0]["ok"] is True and hist[0]["stage_count"] == 3
