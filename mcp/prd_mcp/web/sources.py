"""Admin router: PRD source connectors (Notion sync + future).

4 routes:
- GET    /api/admin/sources              — list sources w/ last-run summary (read from vault manifests)
- GET    /api/admin/sources/{id}/runs    — recent run history for one source
- POST   /api/admin/sources/{id}/run     — kick off a sync run (subprocess)
- GET    /api/admin/sources/{id}/runs/{rid}      — single run state (in-memory + last manifest fallback)
- GET    /api/admin/sources/{id}/runs/{rid}/stream — SSE stream of subprocess stdout/stderr lines

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
from typing import AsyncIterator, Literal

import anyio
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import StreamingResponse
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
# Live log buffers for in-flight runs. Each entry is a dict with:
#   lines: list[str]                       — appended by the producer (subprocess reader)
#   done:  bool                            — flipped when the subprocess finishes
# The SSE generator polls `lines` + `done` and yields new entries as SSE frames.
_run_logs: dict[str, dict] = {}


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


def _init_log_buffer(run_id: str) -> None:
    """Create a fresh line buffer for a run. Idempotent — safe to re-call."""
    _run_logs[run_id] = {"lines": [], "done": False}


def _append_log(run_id: str, line: str) -> None:
    buf = _run_logs.get(run_id)
    if buf is not None:
        buf["lines"].append(line)


def _finish_log(run_id: str) -> None:
    buf = _run_logs.get(run_id)
    if buf is not None:
        buf["done"] = True


async def _read_subprocess_stderr(proc: asyncio.subprocess.Process, run_id: str) -> None:
    """Drain subprocess stderr into the run log buffer (in addition to capturing it).

    The sync CLI's primary output goes to stdout (status lines), but it may also write
    warnings / stack traces to stderr on partial failure. We mirror everything into the
    log buffer so the operator sees it live.
    """
    if proc.stderr is None:
        return
    while True:
        raw = await proc.stderr.readline()
        if not raw:
            return
        text = raw.decode(errors="replace").rstrip("\n").rstrip("\r")
        if text:
            _append_log(run_id, text)


async def _run_subprocess(core: Core, run_id: str) -> None:
    """Spawn the sync CLI, then rebuild the Chroma index from the freshly-synced vault.

    The Sources page promises (in its confirm dialog) "This will write to the vault
    AND re-index Chroma" — without the second step, Library/Search/Status stay empty
    after every sync because the Notion CLI writes .md files but never tells Chroma
    about them. We chain `python -m prd_mcp.cli index` after a successful sync.
    """
    _init_log_buffer(run_id)
    try:
        sync_ok = await _spawn_sync_cli(core, run_id)
        if not sync_ok:
            await _notify_sync_failed(core, run_id)
            return  # error already populated in _runs[run_id]
        await _spawn_index_cli(core, run_id)
    finally:
        _finish_log(run_id)


async def _notify_sync_failed(core: Core, run_id: str) -> None:
    """Fan-out a `sync_failed` notification to every active admin.

    Lazy-imports `notifications` to keep `from prd_mcp.web.sources import router`
    importable in thin envs (mirrors the rbac-lazy pattern elsewhere in this module).
    Builds a fresh AsyncSession from DATABASE_URL because Core only carries
    cfg/store/llm — not the sessionmaker.

    Failures here MUST NOT mask the original sync error: wrapped to log+swallow.
    The Sources page still shows the run as `error` via the manifest.
    """
    try:
        import os
        import logging

        from prd_mcp.web.db import make_engine, make_sessionmaker
        from prd_mcp.web.notifications import notify_admins

        url = os.environ.get("DATABASE_URL")
        if not url:
            return
        eng = make_engine(url)
        sm = make_sessionmaker(eng)
        try:
            run = _runs.get(run_id, {})
            source_label = next(
                (s["label"] for s in SOURCES if s["id"] == run.get("source_id")),
                "Source",
            )
            err = (run.get("error") or "sync failed")[:200]
            async with sm() as s:
                await notify_admins(
                    s,
                    kind="sync_failed",
                    title=f"{source_label} sync failed",
                    body=err,
                    link="/sources",
                )
        finally:
            await eng.dispose()
    except Exception as e:  # noqa: BLE001 — never mask the real sync error
        logging.getLogger("prd_mcp.web.sources").warning("notify_sync_failed swallowed: %s", e)


async def _spawn_sync_cli(core: Core, run_id: str) -> bool:
    """Spawn `npm run sync` (or RUN_CMD/RUN_ARGS override). Returns True on success.

    Streams stdout/stderr line-by-line into _run_logs[run_id] so the SSE endpoint
    can tail the subprocess live. Falls back to capturing after timeout.
    """
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

    # Drain stderr in parallel (mirrors everything into the log buffer) and read
    # stdout line-by-line into the buffer. Either side hitting EOF just returns;
    # we wait for proc.wait() to learn the return code.
    stderr_task = asyncio.create_task(_read_subprocess_stderr(proc, run_id))
    try:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            text = raw.decode(errors="replace").rstrip("\n").rstrip("\r")
            if text:
                _append_log(run_id, text)
        # Drain stderr tail (EOF marker).
        await stderr_task
        try:
            await asyncio.wait_for(proc.wait(), timeout=300)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            _runs[run_id].update(
                finished_at=_now_iso(),
                status="timeout",
                error="exceeded 5-minute timeout",
            )
            return False
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        _runs[run_id].update(
            finished_at=_now_iso(),
            status="timeout",
            error="exceeded 5-minute timeout",
        )
        return False
    except Exception as e:
        proc.kill()
        await proc.wait()
        _runs[run_id].update(
            finished_at=_now_iso(),
            status="error",
            error=f"failed while reading sync output: {e}",
        )
        return False

    if proc.returncode == 0:
        return True

    # On non-zero exit, surface the last few stderr lines already in the buffer.
    recent = "\n".join(_run_logs[run_id]["lines"][-5:]) if _run_logs.get(run_id) else ""
    _runs[run_id].update(
        finished_at=_now_iso(),
        status="error",
        error=recent or f"sync CLI exited {proc.returncode}",
    )
    return False


async def _spawn_index_cli(core: Core, run_id: str) -> None:
    """Spawn `python -m prd_mcp.cli index` to rebuild Chroma embeddings.

    Mirrors the live-streaming pattern used by _spawn_sync_cli so the operator
    sees reindex progress in the same log panel.
    """
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

    stderr_task = asyncio.create_task(_read_subprocess_stderr(proc, run_id))
    summary_tail: list[str] = []
    try:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            text = raw.decode(errors="replace").rstrip("\n").rstrip("\r")
            if text:
                _append_log(run_id, text)
                summary_tail.append(text)
        await stderr_task
        try:
            await asyncio.wait_for(proc.wait(), timeout=300)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            _runs[run_id]["index_error"] = "reindex exceeded 5-minute timeout"
            return
    except Exception as e:
        proc.kill()
        await proc.wait()
        _runs[run_id]["index_error"] = f"failed while reading reindex output: {e}"
        return

    if proc.returncode != 0:
        recent = "\n".join(_run_logs[run_id]["lines"][-5:]) if _run_logs.get(run_id) else ""
        _runs[run_id]["index_error"] = recent or f"reindex exited {proc.returncode}"
        return

    # Parse `indexed N · skipped M · removed R · errors E` from the indexer stdout.
    for line in summary_tail:
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
    _init_log_buffer(run_id)
    background.add_task(_run_subprocess, core, run_id)
    return RunOut(**run)


def _format_sse(event: str, data: str) -> bytes:
    """Encode a single SSE frame. Multi-line data is split per the spec."""
    parts = ["event: " + event]
    for line in data.split("\n"):
        parts.append("data: " + line)
    parts.append("")
    parts.append("")
    return ("\n".join(parts)).encode("utf-8")


async def _stream_run_logs(run_id: str) -> AsyncIterator[bytes]:
    """Async generator that yields new log lines as SSE frames for a single run.

    Polls the `_run_logs[run_id]` buffer every 250 ms — long enough to coalesce
    a batch of fast stdout writes into one event-loop tick, short enough to feel
    live for an operator watching the UI. Emits a final `done` event and closes
    once the subprocess (or its tail) finishes.
    """
    buf = _run_logs.get(run_id)
    if buf is None:
        # Run state was evicted (server restart mid-run, or unknown run id).
        yield _format_sse("error", "run not found")
        yield _format_sse("done", "missing")
        return

    cursor = 0
    # Emit any lines produced before the client subscribed (replay from start).
    snapshot = buf["lines"][cursor:]
    cursor += len(snapshot)
    for line in snapshot:
        yield _format_sse("log", line)

    while not buf["done"]:
        await asyncio.sleep(0.25)
        new = buf["lines"][cursor:]
        if new:
            cursor += len(new)
            for line in new:
                yield _format_sse("log", line)
        else:
            # Heartbeat keeps proxies from closing the connection on idle.
            yield b": ping\n\n"

    # Drain anything appended between the last poll and the done flag.
    tail = buf["lines"][cursor:]
    for line in tail:
        yield _format_sse("log", line)

    run = _runs.get(run_id)
    final_status = run.get("status", "ok") if run else "ok"
    yield _format_sse("done", final_status)


@router.get("/{source_id}/runs/{run_id}/stream")
async def stream_run_route(
    source_id: str,
    run_id: str,
    _=Depends(_resolve_users_manage_dep),
):
    if source_id not in SOURCE_IDS:
        raise HTTPException(404, f"unknown source: {source_id}")
    if run_id not in _runs and run_id not in _run_logs:
        raise HTTPException(404, f"run not found: {run_id}")

    async def generate() -> AsyncIterator[bytes]:
        async for chunk in _stream_run_logs(run_id):
            yield chunk

    return StreamingResponse(generate(), media_type="text/event-stream")


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
