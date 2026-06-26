"""HTTP door for PRD read: Library, Search, Read. Wraps the SAME core _impl
functions the MCP server uses; offloads the sync/Chroma calls off the event loop."""
from __future__ import annotations

from datetime import datetime, timezone

import anyio
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError

from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.web.db import get_db
from prd_mcp.web.models import RecentView, User
from prd_mcp.web.rbac import require_permission
from prd_mcp.server import search_prds_impl, keyword_search_impl, read_prd_impl
from uuid import uuid4

router = APIRouter(prefix="/api/prd")

# Cap how many recent views we expose in one request. The CommandPalette reads
# the latest 8; a larger value is harmless (the limit param clamps down).
_MAX_RECENT_LIMIT = 50


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


@router.get("/recent")
async def recent_prds(
    limit: int = Query(8, ge=1, le=_MAX_RECENT_LIMIT),
    user: User = Depends(require_permission("prd.read")),
    db=Depends(get_db),
):
    """The PRDs the CURRENT user has most recently opened.

    Empty array for users who have never opened a PRD — the UI then falls back
    to a 'Suggested' section from /library. PRD ids are free-form frontmatter
    strings; we don't filter by current store contents because a PRD may have
    been viewed while it existed and since been removed from the vault — that
    ghost row is fine, the UI hides unresolved ids. Sort is newest-first by
    viewed_at; tie-breaker is the row id so the order is stable.
    """
    limit = min(limit, _MAX_RECENT_LIMIT)
    rows = (
        await db.execute(
            select(RecentView.prd_id)
            .where(RecentView.user_id == user.id)
            .order_by(RecentView.viewed_at.desc(), RecentView.id.desc())
            .limit(limit)
        )
    ).scalars().all()
    return {"results": [{"id": pid} for pid in rows]}


async def _record_recent_view(db, user_id, prd_id: str) -> None:
    """Upsert (user_id, prd_id) -> now(). Postgres-specific ON CONFLICT so
    re-viewing a PRD bumps viewed_at rather than producing a duplicate row.
    Fire-and-forget from the read endpoint: a failure here must NOT break the
    PRD read itself (spec says recent list is a UX nicety, not a contract)."""
    try:
        stmt = pg_insert(RecentView).values(
            user_id=user_id, prd_id=prd_id, viewed_at=datetime.now(timezone.utc)
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["user_id", "prd_id"], set_={"viewed_at": stmt.excluded.viewed_at}
        )
        await db.execute(stmt)
        await db.commit()
    except DBAPIError:
        await db.rollback()


@router.get("/{prd_id}")
async def read_one(
    prd_id: str,
    request: Request,
    core: Core = Depends(get_core),
    user: User = Depends(require_permission("prd.read")),
    db=Depends(get_db),
):
    res = await anyio.to_thread.run_sync(read_prd_impl, core.cfg, prd_id)
    if not res.get("found"):
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "PRD not found"}})
    # Record AFTER the read resolves, so a 404 doesn't pollute the recent list.
    await _record_recent_view(db, user.id, prd_id)
    return res


@router.post("/{prd_id}/enrich", status_code=202)
async def enrich(prd_id: str, _=Depends(require_permission("prd.ask"))):
    """Stub endpoint: queues a re-enrichment job for the given PRD.

    Real enrichment wiring is deferred. The stub returns a job id so the UI
    can show optimistic feedback; the orchestrator will pick these up later.
    """
    return {"status": "queued", "id": str(uuid4()), "prd_id": prd_id}


@router.get("/_health/notion")
async def notion_health(
    _=Depends(require_permission("users.manage")),
    core: Core = Depends(get_core),
):
    """Pings Notion's /v1/users/me and classifies the response so the Sources page
    can show a clear "configured correctly / wrong token type / rate-limited"
    banner. No PII is returned — just the workspace name + bot user id.

    Surfaces the most common operator mistake: NOTION_TOKEN is a personal
    access token (starts with `ntn_`) instead of an internal integration
    secret (starts with `secret_` or `ntn_I`). Personal tokens can't read
    shared databases — every call returns `restricted_resource`.
    """
    import os
    from urllib import request as urlrequest
    from urllib.error import HTTPError, URLError

    token = os.environ.get("NOTION_TOKEN", "").strip()
    if not token:
        return {
            "status": "missing",
            "message": "NOTION_TOKEN is not set in mcp/deploy/.env",
            "fix_url": "https://www.notion.so/profile/integrations",
        }

    # Hint about token type from the prefix — Notion issues different prefixes
    # for personal vs internal tokens. Surface this BEFORE the API call so
    # operators don't need to wait for a 401 to know they're using the wrong
    # kind.
    prefix_hint = None
    if token.startswith("ntn_") and not token.startswith("ntn_I"):
        prefix_hint = (
            "NOTION_TOKEN looks like a Personal Access Token. The Notion sync "
            "needs an Internal Integration Secret (starts with `secret_` or "
            "`ntn_I`). Create one at Settings → Connections → Develop integrations."
        )

    req = urlrequest.Request(
        "https://api.notion.com/v1/users/me",
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": "2022-06-28",
        },
    )
    try:
        with urlrequest.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            import json as _json
            data = _json.loads(body)
            bot_id = data.get("id", "unknown")
            bot_name = data.get("name", "unknown")
            workspace_name = "unknown"
            try:
                workspace_name = data.get("bot", {}).get("workspace_name", "unknown")
            except Exception:
                pass
            out = {
                "status": "ok",
                "token_prefix": token[:8] + "...",
                "bot_id": bot_id,
                "bot_name": bot_name,
                "workspace_name": workspace_name,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            }
            if prefix_hint:
                out["warning"] = prefix_hint
            return out
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code == 401:
            return {
                "status": "wrong_token",
                "token_prefix": token[:8] + "...",
                "message": f"Notion rejected the token (HTTP 401). Body: {body[:200]}",
                "fix_url": "https://www.notion.so/profile/integrations",
            }
        if e.code == 403:
            return {
                "status": "wrong_token_type",
                "token_prefix": token[:8] + "...",
                "message": (
                    "Notion returned 403 — the token is valid but cannot read "
                    "the configured database. Most common cause: NOTION_TOKEN "
                    "is a Personal Access Token; the Notion sync needs an "
                    "Internal Integration that has been shared with the "
                    "Product Backlog database."
                ),
                "fix_url": "https://www.notion.so/profile/integrations",
            }
        if e.code == 429:
            return {
                "status": "rate_limited",
                "token_prefix": token[:8] + "...",
                "message": f"Notion rate-limited the check (HTTP 429). Body: {body[:200]}",
            }
        return {
            "status": "error",
            "token_prefix": token[:8] + "...",
            "message": f"Notion returned HTTP {e.code}. Body: {body[:200]}",
        }
    except URLError as e:
        return {
            "status": "unreachable",
            "message": f"Could not reach api.notion.com: {e.reason}",
        }
    except Exception as e:  # noqa: BLE001 — last-resort surface for unexpected errors
        return {
            "status": "error",
            "message": f"Unexpected error: {type(e).__name__}: {e}",
        }