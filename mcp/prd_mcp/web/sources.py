"""Admin router: PRD source connectors (Notion sync + future).

4 routes:
- GET    /api/admin/sources              — list sources w/ last-run summary (read from vault manifests)
- GET    /api/admin/sources/{id}/runs    — recent run history for one source
- POST   /api/admin/sources/{id}/run     — kick off a sync run (subprocess)
- GET    /api/admin/sources/{id}/runs/{rid}  — single run state (in-memory + last manifest fallback)

All routes gated by `users.manage` (admin).

MANIFEST LAYOUT
---------------
The TypeScript sync CLI writes per-stage manifests under `<vault>/.runs/<run_id>/`.
We reuse the existing `manifests.read_run_history` / `read_stage` helpers and
filter by `stage == 'sync'`. The CLI also writes `extra.archived` inside the sync
manifest, which is the source of truth for the "archived" count.

SUBPROCESS
----------
Spec §F2 / §Backend Touches: trigger runs `npm run sync` from inside the app
container. **The current app image (`python:3.10-slim`) does NOT ship
`node`/`npm` or the `src/` tree** — the sync CLI lives at the repo root and is
invoked via `tsx`. To make this work end-to-end the Dockerfile must install
Node + `npm i` the repo's package.json + `COPY src ./src`. Until that lands
the subprocess will fail with "npm: not found" or "ENOENT: src/index.ts".

We default `RUN_CMD` / `RUN_CWD` to safe values and let env override:
  RUN_CMD="npm" RUN_ARGS="run sync" RUN_CWD="/app"

Per-source asyncio.Lock serializes concurrent "Run now" calls. 5-minute hard
timeout — kill + mark `timeout` on expiry.

MODULE-LEVEL IMPORTS
--------------------
`prd_mcp.web.rbac` transitively imports `prd_mcp.web.sessions`, which needs
`argon2` at import time. argon2 isn't installed in thin CI / verification envs,
so we lazy-import rbac inside the dependency factory rather than at module
top level. That keeps `python -c "from prd_mcp.web.sources import router"`
working when only the sync CLI's filesystem helpers are needed.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import uuid
from datetime import datetime, timezone
from typing import Literal

import anyio
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.web.manifests import (
    _list_run_ids,
    _read_stage,
)

router = APIRouter(prefix="/api/admin/sources", tags=["admin"])


# Static source catalog for v1. Notion is the only configured connector; future
# sources (Confluence, Linear) plug in here.
SOURCES: list[dict] = [
    {
        "id": "notion",
        "kind": "notion",
        "label": "Notion",
        "subtitle": "Database: Product Backlog (3f6ac861-35fd-48d0-9252-99a9e202b776)",
        "schedule": "every 4 hours",
    }
]
SOURCE_IDS = frozenset(s["id"] for s in SOURCES)


# Per-source run state. The app is single-process uvicorn (cli.py --workers 1),
# so module-level state survives across requests in one container.
_run_locks: dict[str, asyncio.Lock] = {}
_runs: dict[str, dict] = {}


# ---- Pydantic models ----

SourceStatus = Literal["idle", "running", "ok", "error"]
RunStatus = Literal["running", "ok", "error", "timeout"]


class RunCounts(BaseModel):
    synced: int = 0
    skipped: int = 0
    archived: int = 0
    errors: int = 0


class SourceOut(BaseModel):
    id: str
    kind: str
    label: str
    subtitle: str
    status: SourceStatus
    last_run_at: str | None
    last_run_summary: RunCounts | None
    schedule: str


class RunOut(BaseModel):
    id: str
    source_id: str
    started_at: str
    finished_at: str | None
    status: RunStatus
    counts: RunCounts | None
    error: str | None


# ---- helpers ----


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _vault_path(core: Core) -> str:
    return getattr(core.cfg, "vault_path", "")


def _counts_from_manifest(m: dict) -> RunCounts:
    """Map a sync-stage manifest to the RunCounts the UI expects.

    Counts shape (see src/index.ts buildSyncManifest):
      counts.processed = succeeded + failed
      counts.succeeded = synced + archived
      counts.failed    = len(errors)
      counts.skipped   = skipped
      extra.archived   = archived
    """
    c = m.get("counts") or {}
    extra = m.get("extra") or {}
    archived = int(extra.get("archived", 0))
    return RunCounts(
        synced=int(c.get("succeeded", 0)) - archived,
        skipped=int(c.get("skipped", 0)),
        archived=archived,
        errors=int(c.get("failed", 0)),
    )


def _list_sync_manifests(vault_path: str, limit: int = 10) -> list[tuple[str, dict]]:
    """Return (run_id, sync_manifest) tuples, newest first, up to `limit`.

    Reads <vault>/.runs/<run_id>/sync.json. Excludes run dirs without a sync
    stage — those are orchestrator runs that bypassed the sync CLI.
    """
    out: list[tuple[str, dict]] = []
    for rid in _list_run_ids(vault_path)[:limit]:
        m = _read_stage(vault_path, rid, "sync")
        if m is not None:
            out.append((rid, m))
    return out


def _latest_sync_summary(vault_path: str) -> dict | None:
    items = _list_sync_manifests(vault_path, limit=1)
    return items[0][1] if items else None


def _running_for(source_id: str) -> dict | None:
    for run in _runs.values():
        if run.get("source_id") == source_id and run.get("status") == "running":
            return run
    return None


async def _run_subprocess(core: Core, run_id: str) -> None:
    """Spawn the sync CLI, then rebuild the Chroma index from the freshly-synced vault.

    The Sources page promises (in its confirm dialog) "This will write to the vault
    AND re-index Chroma" — without the second step, Library/Search/Status stay empty
    after every sync because the Notion CLI writes .md files but never tells Chroma
    about them. We chain `python -m prd_mcp.cli index` after a successful sync.
    """
    sync_ok = await _spawn_sync_cli(core, run_id)
    if not sync_ok:
        return  # error already populated in _runs[run_id]
    await _spawn_index_cli(core, run_id)


async def _spawn_sync_cli(core: Core, run_id: str) -> bool:
    """Spawn `npm run sync` (or RUN_CMD/RUN_ARGS override). Returns True on success."""
    cmd = os.environ.get("RUN_CMD", "npm")
    args_str = os.environ.get("RUN_ARGS", "run sync")
    args = args_str.split()
    cwd = os.environ.get("RUN_CWD", "/app")
    env = os.environ.copy()
    env["VAULT_PATH"] = _vault_path(core)
    env["RUN_ID"] = run_id
    # Mirror the cli.py convention: PRD_SECRETS=env tells the TS CLI to read
    # NOTION_TOKEN from process env (the alternative is the macOS keychain,
    # which doesn't exist on Linux).
    env.setdefault("PRD_SECRETS", "env")

    proc: asyncio.subprocess.Process | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            cmd, *args,
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        _runs[run_id].update(
            finished_at=_now_iso(),
            status="error",
            error=f"sync CLI not found ({cmd} in {cwd}): {e}",
        )
        return False
    except Exception as e:
        _runs[run_id].update(
            finished_at=_now_iso(),
            status="error",
            error=f"failed to spawn sync CLI: {e}",
        )
        return False

    try:
        # 5-minute hard timeout — the sync CLI now has capped 15s backoffs (3 retries)
        # + actual request time, so 5 min is enough margin to surface a rate-limit error
        # cleanly instead of getting killed mid-retry.
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        _runs[run_id].update(
            finished_at=_now_iso(),
            status="timeout",
            error="exceeded 5-minute timeout",
        )
        return False

    if proc.returncode == 0:
        return True

    tail = (stderr or b"").decode(errors="replace")[-1000:]
    _runs[run_id].update(
        finished_at=_now_iso(),
        status="error",
        error=tail or f"sync CLI exited {proc.returncode}",
    )
    return False


async def _spawn_index_cli(core: Core, run_id: str) -> None:
    """Spawn `python -m prd_mcp.cli index` to rebuild Chroma embeddings."""
    cmd = ["python", "-m", "prd_mcp.cli", "index"]
    env = os.environ.copy()
    env["VAULT_PATH"] = _vault_path(core)
    env["RUN_ID"] = run_id
    env.setdefault("PRD_SECRETS", "env")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd="/app",
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception as e:
        # Index failure shouldn't downgrade a successful sync — annotate only.
        _runs[run_id]["index_error"] = f"failed to spawn reindex: {e}"
        return

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        _runs[run_id]["index_error"] = "reindex exceeded 5-minute timeout"
        return

    if proc.returncode != 0:
        tail = (stderr or b"").decode(errors="replace")[-1000:]
        _runs[run_id]["index_error"] = tail or f"reindex exited {proc.returncode}"
        return

    # Parse `indexed N · skipped M · removed R · errors E` from the indexer stdout.
    summary = (stdout or b"").decode(errors="replace")
    for line in summary.splitlines():
        if line.startswith("indexed "):
            counts: dict[str, int] = {}
            for p in line.split("·"):
                p = p.strip()
                if " " in p:
                    k, _, v = p.partition(" ")
                    try:
                        counts[k] = int(v)
                    except ValueError:
                        pass
            _runs[run_id]["index_counts"] = counts
            break


# ---- permission dep (lazy import to keep rbac deps optional) ----

# FastAPI supports callable-dependencies: passing the bare function (not the
# call result) to `Depends(...)` defers its invocation until request time. We
# use that to import `rbac` (which transitively pulls `argon2`) lazily — keeps
# this module importable in thin CI envs where only the filesystem helpers are
# available. The verification gate `from prd_mcp.web.sources import router`
# must succeed without argon2 installed.


def _resolve_users_manage_dep():
    """Lazy FastAPI dep: requires `users.manage`. Imports rbac only at call time."""
    from prd_mcp.web.rbac import require_permission
    return require_permission("users.manage")


# ---- routes ----


@router.get("", response_model=list[SourceOut])
async def list_sources_route(
    _=Depends(_resolve_users_manage_dep),
    core: Core = Depends(get_core),
):
    vault_path = _vault_path(core)
    latest: dict | None = None
    if vault_path:
        latest = await anyio.to_thread.run_sync(_latest_sync_summary, vault_path)

    out: list[SourceOut] = []
    for src in SOURCES:
        running = _running_for(src["id"])
        if running is not None:
            status: SourceStatus = "running"
            last_run_at: str | None = None
            last_counts: RunCounts | None = None
        elif latest is None:
            status = "idle"
            last_run_at = None
            last_counts = None
        else:
            ok = bool(latest.get("ok"))
            status = "ok" if ok else "error"
            last_run_at = latest.get("finished_at")
            last_counts = _counts_from_manifest(latest)
        out.append(
            SourceOut(
                id=src["id"],
                kind=src["kind"],
                label=src["label"],
                subtitle=src["subtitle"],
                status=status,
                last_run_at=last_run_at,
                last_run_summary=last_counts,
                schedule=src["schedule"],
            )
        )
    return out


@router.get("/{source_id}/runs", response_model=list[RunOut])
async def list_runs_route(
    source_id: str,
    limit: int = 10,
    _=Depends(_resolve_users_manage_dep),
    core: Core = Depends(get_core),
):
    if source_id not in SOURCE_IDS:
        raise HTTPException(404, f"unknown source: {source_id}")
    vault_path = _vault_path(core)

    out: list[RunOut] = []

    # In-memory runs (newest last in our dict; we want newest first).
    mem_runs = [r for r in _runs.values() if r.get("source_id") == source_id]
    mem_runs.sort(key=lambda r: r.get("started_at", ""), reverse=True)
    for r in mem_runs[:limit]:
        counts = r.get("counts") or RunCounts().model_dump()
        out.append(
            RunOut(
                id=r["id"],
                source_id=source_id,
                started_at=r["started_at"],
                finished_at=r.get("finished_at"),
                status=r.get("status", "running"),
                counts=RunCounts(**counts) if isinstance(counts, dict) else None,
                error=r.get("error"),
            )
        )

    # Manifest-based history (fills in older runs).
    if vault_path:
        manifest_runs = await anyio.to_thread.run_sync(
            _list_sync_manifests, vault_path, limit
        )
        seen_run_ids = {r.id for r in out}
        for rid, m in manifest_runs:
            if rid in seen_run_ids:
                continue
            ok = bool(m.get("ok"))
            out.append(
                RunOut(
                    id=rid,
                    source_id=source_id,
                    started_at=m.get("started_at", ""),
                    finished_at=m.get("finished_at"),
                    status="ok" if ok else "error",
                    counts=_counts_from_manifest(m),
                    error=None,
                )
            )

    return out[:limit]


@router.post("/{source_id}/run", response_model=RunOut, status_code=202)
async def trigger_run_route(
    source_id: str,
    background: BackgroundTasks,
    _=Depends(_resolve_users_manage_dep),
    core: Core = Depends(get_core),
):
    if source_id not in SOURCE_IDS:
        raise HTTPException(404, f"unknown source: {source_id}")
    lock = _run_locks.setdefault(source_id, asyncio.Lock())
    if lock.locked():
        raise HTTPException(409, "a run is already in progress for this source")
    run_id = str(uuid.uuid4())
    run = {
        "id": run_id,
        "source_id": source_id,
        "started_at": _now_iso(),
        "finished_at": None,
        "status": "running",
        "counts": None,
        "error": None,
    }
    _runs[run_id] = run
    background.add_task(_run_subprocess, core, run_id)
    return RunOut(**run)


@router.get("/{source_id}/runs/{run_id}", response_model=RunOut)
async def get_run_route(
    source_id: str,
    run_id: str,
    _=Depends(_resolve_users_manage_dep),
    core: Core = Depends(get_core),
):
    if source_id not in SOURCE_IDS:
        raise HTTPException(404, f"unknown source: {source_id}")
    run = _runs.get(run_id)
    if run and run.get("source_id") == source_id:
        return RunOut(**run)
    # Fall back to manifest lookup.
    vault_path = _vault_path(core)
    if vault_path:
        manifests = await anyio.to_thread.run_sync(
            _list_sync_manifests, vault_path, limit=50
        )
        for rid, m in manifests:
            if rid == run_id:
                ok = bool(m.get("ok"))
                return RunOut(
                    id=rid,
                    source_id=source_id,
                    started_at=m.get("started_at", ""),
                    finished_at=m.get("finished_at"),
                    status="ok" if ok else "error",
                    counts=_counts_from_manifest(m),
                    error=None,
                )
    raise HTTPException(404, f"run not found: {run_id}")
