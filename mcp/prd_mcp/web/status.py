from __future__ import annotations

import anyio
from fastapi import APIRouter, Depends, Query

from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.web.rbac import require_permission
from prd_mcp.web.manifests import read_latest_run, read_run_history

router = APIRouter(prefix="/api/status")


@router.get("/pipeline")
async def pipeline(core: Core = Depends(get_core), _=Depends(require_permission("status.view"))):
    # read_latest_run does filesystem I/O -> offload (Codex #6).
    latest = await anyio.to_thread.run_sync(read_latest_run, core.cfg.vault_path)
    if latest is None:
        return {"run_id": None, "stages": {}, "halted": False, "halt_reason": None, "halted_at": None}
    return latest


@router.get("/history")
async def history(limit: int = Query(10), core: Core = Depends(get_core),
                  _=Depends(require_permission("status.view"))):
    runs = await anyio.to_thread.run_sync(read_run_history, core.cfg.vault_path, limit)
    return {"runs": runs}


@router.get("/coverage")
async def coverage(core: Core = Depends(get_core), _=Depends(require_permission("status.view"))):
    # total PRDs vs how many are enriched (have a body_hash in the index).
    # store.stored_hashes() hits Chroma -> offload (Codex #6).
    hashes = await anyio.to_thread.run_sync(core.store.stored_hashes)
    total = len(hashes)
    enriched = sum(1 for h in hashes.values() if h)
    return {"total": total, "enriched": enriched, "unenriched": total - enriched}
