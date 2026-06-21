import json
import os


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
