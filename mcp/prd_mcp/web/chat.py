from __future__ import annotations

import json
import uuid
import anyio
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

router = APIRouter(prefix="/api/chat")


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


async def _next_seq(db, conv_id) -> int:
    cur = (
        await db.execute(
            select(func.coalesce(func.max(Message.seq), 0)).where(
                Message.conversation_id == conv_id
            )
        )
    ).scalar_one()
    return int(cur) + 1


@router.post("/conversations/{cid}/messages")
async def post_message(
    cid: str,
    body: MessageIn,
    user: User = Depends(require_permission("prd.ask")),
    db=Depends(get_db),
    core: Core = Depends(get_core),
):
    conv = await _owned_or_none(db, user, cid)
    if conv is None:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "not_found", "message": "conversation not found"}},
        )
    if not body.content or not body.content.strip():
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": "empty message"}},
        )

    # Claim the one-at-a-time generation lock atomically.
    # WHERE generating IS FALSE ensures only one writer wins; rowcount==0 → already busy.
    claimed = (
        await db.execute(
            update(Conversation)
            .where(Conversation.id == conv.id, Conversation.generating.is_(False))
            .values(generating=True)
        )
    ).rowcount
    await db.commit()
    if not claimed:
        return JSONResponse(
            status_code=409,
            content={"error": {"code": "conversation_busy", "message": "a response is already generating"}},
        )

    # Load history BEFORE inserting the new row (so rewrite excludes the current turn),
    # then persist the user message row — all committed before streaming starts.
    history_rows = (
        await db.execute(
            select(Message)
            .where(Message.conversation_id == conv.id)
            .order_by(Message.seq)
        )
    ).scalars().all()
    history = [{"role": m.role, "content": m.content} for m in history_rows]
    user_seq = await _next_seq(db, conv.id)
    db.add(Message(conversation_id=conv.id, seq=user_seq, role="user", content=body.content))
    if conv.title == "":
        conv.title = body.content[:80]
    await db.commit()

    # Capture conv.id into a local before the generator closes the request session.
    conv_id_val = conv.id

    async def event_gen():
        acc, sources, grounded, finish = [], [], None, "complete"
        try:
            standalone = await anyio.to_thread.run_sync(
                rewrite_query, history, body.content, core.llm.chat
            )
            yield {"event": "rewrite", "data": standalone}

            results, verdict = await anyio.to_thread.run_sync(
                retrieve, standalone, core.store, core.llm.embed, core.cfg.top_k, core.cfg.score_threshold
            )
            sources = format_sources(results)
            grounded = verdict != "no_match"
            yield {"event": "sources", "data": json.dumps({"sources": sources, "verdict": verdict})}

            async for tok in answer_stream(body.content, results, verdict, core.llm.chat_stream):
                acc.append(tok)
                yield {"event": "token", "data": tok}

        except anyio.get_cancelled_exc_class():
            finish = "client_disconnected"
            raise
        except Exception:
            finish = "llm_error"
            yield {"event": "error", "data": "generation failed"}
        finally:
            # Use a FRESH session (not the request-scoped `db`) because the request
            # session may be closing while the SSE response is still streaming.
            async with db_mod._sessionmaker() as s:
                a_seq = (
                    await s.execute(
                        select(func.coalesce(func.max(Message.seq), 0)).where(
                            Message.conversation_id == conv_id_val
                        )
                    )
                ).scalar_one() + 1
                s.add(
                    Message(
                        conversation_id=conv_id_val,
                        seq=a_seq,
                        role="assistant",
                        content="".join(acc) or "",
                        sources=sources,
                        grounded=grounded if finish == "complete" else None,
                        finish_reason=finish,
                    )
                )
                await s.execute(
                    update(Conversation)
                    .where(Conversation.id == conv_id_val)
                    .values(generating=False, updated_at=func.now())
                )
                await s.commit()
            if finish == "complete":
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
