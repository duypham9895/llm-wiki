from __future__ import annotations

import json
import logging
import uuid
import anyio
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import delete, func, select, update
from sse_starlette.sse import EventSourceResponse

from prd_mcp.web import db as db_mod
from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.web.db import get_db
from prd_mcp.web.rbac import require_permission
from prd_mcp.web.models import User
from prd_mcp.web.chatmodels import Conversation, Message
from prd_mcp.answer import rewrite_query, answer_stream, format_sources
from prd_mcp.retrieve import retrieve

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat")


async def sweep_stale_generating(session, *, older_than_minutes: int = 30, now=None) -> int:
    """Clear generating=True on conversations whose updated_at is stale.

    A healthy SSE stream bumps updated_at when it persists the user row and again
    when it releases the lock in the finally block.  30 minutes (default) is far
    longer than any real stream, so only genuinely-wedged locks — caused by a
    rare client disconnect in the gap between the lock-claim commit and
    sse-starlette first iterating the generator — are swept.  The threshold is
    deliberately conservative to never interrupt a legitimately long in-flight
    stream.

    Does NOT commit; the caller is responsible for committing (mirrors the
    contract used by sessions_mod.purge_expired in _purge_once).

    Returns the number of rows updated (0 or more).
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=older_than_minutes)
    result = await session.execute(
        update(Conversation)
        .where(Conversation.generating.is_(True), Conversation.updated_at < cutoff)
        .values(generating=False)
    )
    return result.rowcount


async def _owned_or_none(db, user: User, cid: str):
    try:
        cid_u = uuid.UUID(cid)
    except ValueError:
        return None
    row = (await db.execute(select(Conversation).where(
        Conversation.id == cid_u, Conversation.user_id == user.id))).scalar_one_or_none()
    return row


@router.get("/conversations")
async def list_conversations(user: User = Depends(require_permission("prd.ask")), db=Depends(get_db)):
    rows = (await db.execute(select(Conversation).where(Conversation.user_id == user.id)
                             .order_by(Conversation.updated_at.desc()))).scalars().all()
    return [{"id": str(c.id), "title": c.title, "updated_at": c.updated_at.isoformat()} for c in rows]


@router.post("/conversations")
async def create_conversation(user: User = Depends(require_permission("prd.ask")), db=Depends(get_db)):
    conv = Conversation(user_id=user.id, title="")
    db.add(conv)
    await db.commit()
    return {"id": str(conv.id)}


@router.get("/conversations/{cid}")
async def get_conversation(cid: str, user: User = Depends(require_permission("prd.ask")), db=Depends(get_db)):
    conv = await _owned_or_none(db, user, cid)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "conversation not found"}})
    msgs = (await db.execute(select(Message).where(Message.conversation_id == conv.id)
                             .order_by(Message.seq))).scalars().all()
    return {"id": str(conv.id), "title": conv.title,
            "messages": [{"seq": m.seq, "role": m.role, "content": m.content,
                          "sources": m.sources, "grounded": m.grounded,
                          "finish_reason": m.finish_reason} for m in msgs]}


class MessageIn(BaseModel):
    content: str




@router.post("/conversations/{cid}/messages")
async def post_message(
    cid: str,
    body: MessageIn,
    user: User = Depends(require_permission("prd.ask")),
    db=Depends(get_db),
    core: Core = Depends(get_core),
):
    # 404 — not owned
    conv = await _owned_or_none(db, user, cid)
    if conv is None:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "not_found", "message": "conversation not found"}},
        )
    # 422 — empty content
    if not body.content or not body.content.strip():
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": "empty message"}},
        )

    # Claim the one-at-a-time generation lock atomically.
    # WHERE generating IS FALSE ensures only one writer wins; rowcount==0 → already busy.
    # Refresh updated_at on claim (Codex): the stale-lock sweep keys off updated_at, so
    # a freshly-claimed conversation MUST look recent — otherwise a conversation whose
    # updated_at predates the sweep window could be swept mid-stream, releasing the lock
    # out from under an active generation.
    claimed = (
        await db.execute(
            update(Conversation)
            .where(Conversation.id == conv.id, Conversation.generating.is_(False))
            .values(generating=True, updated_at=func.now())
        )
    ).rowcount
    await db.commit()
    if not claimed:
        return JSONResponse(
            status_code=409,
            content={"error": {"code": "conversation_busy", "message": "a response is already generating"}},
        )

    # Capture everything needed by the generator into locals.
    # The request-scoped `db` may be closed once streaming starts, so the
    # generator uses fresh sessions for ALL its DB work.
    conv_id_val = conv.id
    content_val = body.content
    title_was_empty = conv.title == ""

    async def event_gen():
        acc, sources, grounded, finish = [], [], None, "complete"
        a_seq: int | None = None
        try:
            # ----------------------------------------------------------------
            # BLOCKER #2 fix: history load + user-row insert moved INSIDE the
            # try so the finally's lock-release covers the entire post-claim
            # lifetime.  Use fresh sessions (request db may be closing).
            # ----------------------------------------------------------------
            # Read history, compute the user seq, and insert the user row in ONE
            # session/transaction. The generating lock already serializes writers
            # per conversation, so MAX(seq)+1 is safe; doing it in a single session
            # (no yield between read and write) closes any seq-collision window.
            async with db_mod._sessionmaker() as s:
                history_rows = (
                    await s.execute(
                        select(Message)
                        .where(Message.conversation_id == conv_id_val)
                        .order_by(Message.seq)
                    )
                ).scalars().all()
                history = [{"role": m.role, "content": m.content} for m in history_rows]
                user_seq = int(
                    (
                        await s.execute(
                            select(func.coalesce(func.max(Message.seq), 0)).where(
                                Message.conversation_id == conv_id_val
                            )
                        )
                    ).scalar_one()
                ) + 1
                s.add(Message(
                    conversation_id=conv_id_val,
                    seq=user_seq,
                    role="user",
                    content=content_val,
                ))
                if title_was_empty:
                    await s.execute(
                        update(Conversation)
                        .where(Conversation.id == conv_id_val)
                        .values(title=content_val[:80])
                    )
                await s.commit()

            # ----------------------------------------------------------------
            # LLM pipeline: rewrite → retrieve → stream
            # ----------------------------------------------------------------
            standalone = await anyio.to_thread.run_sync(
                rewrite_query, history, content_val, core.llm.chat
            )
            yield {"event": "rewrite", "data": standalone}

            results, verdict = await anyio.to_thread.run_sync(
                retrieve, standalone, core.store, core.llm.embed, core.cfg.top_k, core.cfg.score_threshold
            )
            sources = format_sources(results)
            grounded = verdict != "no_match"
            yield {"event": "sources", "data": json.dumps({"sources": sources, "verdict": verdict})}

            async for tok in answer_stream(content_val, results, verdict, core.llm.chat_stream):
                acc.append(tok)
                yield {"event": "token", "data": tok}

        except anyio.get_cancelled_exc_class():
            finish = "client_disconnected"
            raise
        except Exception:
            finish = "llm_error"
            yield {"event": "error", "data": "generation failed"}
        finally:
            # ----------------------------------------------------------------
            # BLOCKER #1 fix: shield the entire cleanup with CancelScope so
            # a client disconnect cannot interrupt the lock release mid-await.
            #
            # MAJOR #3 fix: two separate transactions — assistant-row insert
            # is best-effort (failure is swallowed/logged), lock release is
            # unconditional and always commits last.
            # ----------------------------------------------------------------
            with anyio.CancelScope(shield=True):
                # Step 1: best-effort persist assistant row (own transaction).
                # a_seq is assigned ONLY after a successful commit — so a failure
                # anywhere (add/commit) leaves a_seq None and the `done` guard below
                # correctly suppresses the done event for a row that didn't persist.
                try:
                    async with db_mod._sessionmaker() as s:
                        candidate_seq = (
                            await s.execute(
                                select(func.coalesce(func.max(Message.seq), 0)).where(
                                    Message.conversation_id == conv_id_val
                                )
                            )
                        ).scalar_one() + 1
                        s.add(
                            Message(
                                conversation_id=conv_id_val,
                                seq=candidate_seq,
                                role="assistant",
                                content="".join(acc) or "",
                                sources=sources,
                                grounded=grounded if finish == "complete" else None,
                                finish_reason=finish,
                            )
                        )
                        await s.commit()
                        a_seq = candidate_seq  # only set after the row is durably committed
                except Exception:
                    log.exception(
                        "Failed to persist assistant message for conv %s; "
                        "lock will still be released.",
                        conv_id_val,
                    )

                # Step 2: unconditional lock release (own transaction)
                try:
                    async with db_mod._sessionmaker() as s:
                        await s.execute(
                            update(Conversation)
                            .where(Conversation.id == conv_id_val)
                            .values(generating=False, updated_at=func.now())
                        )
                        await s.commit()
                except Exception:
                    log.exception(
                        "CRITICAL: failed to release generating lock for conv %s",
                        conv_id_val,
                    )

            # done event OUTSIDE the shield (it's a yield, not DB work).
            # Only emit `done` when the assistant row actually persisted (a_seq set);
            # if the best-effort persist failed, a_seq stays None and emitting
            # `done: "None"` would hand the client an unparseable seq. The lock is
            # already released above, so suppressing `done` here is safe — the
            # client sees the streamed tokens but no done marker on this rare path.
            if finish == "complete" and a_seq is not None:
                yield {"event": "done", "data": str(a_seq)}

    return EventSourceResponse(event_gen())


@router.delete("/conversations/{cid}")
async def delete_conversation(cid: str, user: User = Depends(require_permission("prd.ask")), db=Depends(get_db)):
    conv = await _owned_or_none(db, user, cid)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "conversation not found"}})
    await db.execute(
        delete(Conversation).where(
            Conversation.id == conv.id, Conversation.user_id == user.id
        )
    )
    await db.commit()
    return Response(status_code=204)
