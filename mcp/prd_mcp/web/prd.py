"""HTTP door for PRD read: Library, Search, Read. Wraps the SAME core _impl
functions the MCP server uses; offloads the sync/Chroma calls off the event loop."""
from __future__ import annotations

import anyio
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.web.rbac import require_permission
from prd_mcp.server import search_prds_impl, keyword_search_impl, read_prd_impl

router = APIRouter(prefix="/api/prd")


@router.get("/search")
async def search(q: str = Query(""), mode: str = Query("semantic"), k: int = Query(8),
                 core: Core = Depends(get_core), _=Depends(require_permission("prd.read"))):
    if mode == "keyword":
        return await anyio.to_thread.run_sync(keyword_search_impl, core.cfg, core.store, core.llm, q, k)
    return await anyio.to_thread.run_sync(search_prds_impl, core.cfg, core.store, core.llm, q, k)


@router.get("/library")
async def library(status: str = Query(None), tag: str = Query(None),
                  cursor: str = Query(None), limit: int = Query(50),
                  core: Core = Depends(get_core), _=Depends(require_permission("prd.read"))):
    # Store.list_cards (Step 0) is sync + touches Chroma -> offload.
    return await anyio.to_thread.run_sync(
        lambda: core.store.list_cards(status=status, tag=tag, cursor=cursor, limit=limit))


@router.get("/{prd_id}")
async def read_one(prd_id: str, core: Core = Depends(get_core),
                   _=Depends(require_permission("prd.read"))):
    res = await anyio.to_thread.run_sync(read_prd_impl, core.cfg, prd_id)
    if not res.get("found"):
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "PRD not found"}})
    return res
