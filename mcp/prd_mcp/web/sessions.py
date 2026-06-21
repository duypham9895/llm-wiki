"""The ONLY module that reads/writes the sessions table.

All functions take an explicit `now` so expiry is deterministic under test.
Expiry rule: valid iff now < idle_expires_at AND now < absolute_expires_at.
Idle slides on resolve; absolute never moves.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, select

from prd_mcp.web.models import Session
from prd_mcp.web.security import hash_token, new_session_token
from prd_mcp.web.settings import WebSettings


async def create_session(db, user_id: uuid.UUID, settings: WebSettings, *, now: datetime) -> tuple[str, Session]:
    token = new_session_token()
    row = Session(
        user_id=user_id,
        token_hash=hash_token(token),
        created_at=now,
        idle_expires_at=now + timedelta(hours=settings.session_idle_hours),
        absolute_expires_at=now + timedelta(days=settings.session_absolute_days),
        last_seen_at=now,
    )
    db.add(row)
    await db.flush()
    return token, row


async def resolve_session(db, raw_token: str, settings: WebSettings, *, now: datetime) -> Session | None:
    token_hash = hash_token(raw_token)
    row = (await db.execute(select(Session).where(Session.token_hash == token_hash))).scalar_one_or_none()
    if row is None:
        return None
    if now >= row.idle_expires_at or now >= row.absolute_expires_at:
        await db.execute(delete(Session).where(Session.id == row.id))  # opportunistic purge
        await db.flush()
        return None
    # slide idle window (capped implicitly by absolute on the next resolve)
    row.idle_expires_at = now + timedelta(hours=settings.session_idle_hours)
    if now - row.last_seen_at >= timedelta(minutes=settings.last_seen_throttle_min):
        row.last_seen_at = now
    await db.flush()
    return row


async def revoke_session(db, raw_token: str) -> None:
    await db.execute(delete(Session).where(Session.token_hash == hash_token(raw_token)))
    await db.flush()


async def revoke_user_sessions(db, user_id: uuid.UUID, *, except_token_hash: str | None = None) -> int:
    stmt = delete(Session).where(Session.user_id == user_id)
    if except_token_hash is not None:
        stmt = stmt.where(Session.token_hash != except_token_hash)
    result = await db.execute(stmt)
    await db.flush()
    return result.rowcount or 0


async def purge_expired(db, *, now: datetime) -> int:
    stmt = delete(Session).where((Session.idle_expires_at <= now) | (Session.absolute_expires_at <= now))
    result = await db.execute(stmt)
    await db.flush()
    return result.rowcount or 0
