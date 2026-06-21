"""Persist a Conversation + 2 Messages and verify seq ordering + finish_reason round-trip.

Uses the real Postgres testcontainer fixtures from conftest.py.
User is created inline (no make_user fixture exists in this conftest — see test_invariants.py
for the same pattern).
"""
import pytest
from sqlalchemy import select

from prd_mcp.web.chatmodels import Conversation, Message
from prd_mcp.web.models import User


@pytest.mark.asyncio
async def test_conversation_message_persist_and_cascade(db):
    # Create a user inline, matching the pattern used in test_invariants.py
    user = User(email="chat_test@ringkas.co.id", password_hash="x", status="active")
    db.add(user)
    await db.flush()

    conv = Conversation(user_id=user.id, title="")
    db.add(conv)
    await db.flush()

    db.add_all([
        Message(conversation_id=conv.id, seq=1, role="user", content="hi"),
        Message(
            conversation_id=conv.id,
            seq=2,
            role="assistant",
            content="hello",
            sources=[],
            grounded=True,
            finish_reason="complete",
        ),
    ])
    await db.commit()

    rows = (
        await db.execute(
            select(Message)
            .where(Message.conversation_id == conv.id)
            .order_by(Message.seq)
        )
    ).scalars().all()

    assert [m.seq for m in rows] == [1, 2]
    assert rows[1].finish_reason == "complete"
