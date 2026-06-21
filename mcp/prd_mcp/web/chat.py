from __future__ import annotations

import uuid
from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select

from prd_mcp.web.db import get_db
from prd_mcp.web.rbac import require_permission
from prd_mcp.web.models import User
from prd_mcp.web.chatmodels import Conversation, Message

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
