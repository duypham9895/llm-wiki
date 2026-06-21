import json
import os

STAGES = ("sync", "enrich", "index")


def _runs_dir(vault_path: str) -> str:
    return os.path.join(vault_path, ".runs")


def _list_run_ids(vault_path: str) -> list[str]:
    d = _runs_dir(vault_path)
    if not os.path.isdir(d):
        return []
    return sorted((name for name in os.listdir(d) if os.path.isdir(os.path.join(d, name))), reverse=True)


def _read_stage(vault_path: str, run_id: str, stage: str) -> dict | None:
    try:
        with open(os.path.join(_runs_dir(vault_path), run_id, f"{stage}.json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def read_latest_run(vault_path: str) -> dict | None:
    ids = _list_run_ids(vault_path)
    if not ids:
        return None
    run_id = ids[0]
    stages = {s: m for s in STAGES if (m := _read_stage(vault_path, run_id, s)) is not None}
    summary = _read_stage(vault_path, run_id, "summary") or {}
    # The orchestrator writes halt fields under `extra` (summary uses the shared manifest shape) — Codex #5.
    sx = summary.get("extra") or {}
    halted = sx.get("halted")
    halt_reason = sx.get("halt_reason")
    halted_at = sx.get("halted_at")
    if halted is None:
        # No summary yet: infer a halt if any stage is missing OR any present stage is not ok.
        halted = (len(stages) < len(STAGES)) or any(not m.get("ok", False) for m in stages.values())
        if halted and halt_reason is None:
            bad = next((s for s in STAGES if s not in stages or not stages[s].get("ok", False)), None)
            halt_reason = f"stage '{bad}' did not complete successfully" if bad else None
            halted_at = bad
    return {"run_id": run_id, "stages": stages, "halted": bool(halted),
            "halt_reason": halt_reason, "halted_at": halted_at}


def read_run_history(vault_path: str, limit: int = 10) -> list[dict]:
    out = []
    for run_id in _list_run_ids(vault_path)[:limit]:
        stages = [s for s in STAGES if _read_stage(vault_path, run_id, s) is not None]
        ok = all((m := _read_stage(vault_path, run_id, s)) and m.get("ok") for s in stages) if stages else False
        out.append({"run_id": run_id, "ok": ok, "stage_count": len(stages)})
    return out


def write_index_manifest(vault_path: str, run_id: str, started_at: str, finished_at: str,
                         res: dict, index_nonempty: bool) -> str:
    run_dir = os.path.join(vault_path, ".runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    errors = int(res.get("errors", 0))
    indexed = int(res.get("indexed", 0))
    bad = errors > 0 or not index_nonempty   # Codex #4: an empty index is a failure, not exit 0
    manifest = {
        "stage": "index",
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": finished_at,
        "ok": not bad,
        "exit_code": 1 if bad else 0,
        "counts": {
            "processed": indexed,
            "succeeded": indexed,
            "failed": errors,
            "skipped": int(res.get("skipped", 0)),
        },
        "errors": [],
        "extra": {"removed": int(res.get("removed", 0)), "index_nonempty": index_nonempty},
    }
    path = os.path.join(run_dir, "index.json")
    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=2)
    return path
