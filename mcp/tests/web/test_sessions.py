from datetime import datetime, timedelta, timezone

import pytest

from prd_mcp.web.models import User
from prd_mcp.web import sessions as S
from prd_mcp.web.security import hash_token


def utc(**kw):
    return datetime(2026, 6, 20, 12, 0, 0, tzinfo=timezone.utc) + timedelta(**kw)


async def _user(db) -> User:
    u = User(email="s@ringkas.co.id", password_hash="x", status="active")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_create_then_resolve(db, settings):
    u = await _user(db)
    now = utc()
    token, row = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    assert row.token_hash == hash_token(token)
    resolved = await S.resolve_session(db, token, settings, now=now + timedelta(minutes=1))
    assert resolved is not None
    assert resolved.user_id == u.id


async def test_idle_expiry_invalidates(db, settings):
    u = await _user(db)
    now = utc()
    token, _ = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    later = now + timedelta(hours=settings.session_idle_hours, minutes=1)
    assert await S.resolve_session(db, token, settings, now=later) is None


async def test_absolute_expiry_invalidates_even_if_recently_active(db, settings):
    u = await _user(db)
    now = utc()
    token, _ = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    # keep sliding idle right up to the absolute cap
    t = now
    for _ in range(40):
        t = t + timedelta(hours=settings.session_idle_hours - 1)
        r = await S.resolve_session(db, token, settings, now=t)
        if r is None:
            break
    past_absolute = now + timedelta(days=settings.session_absolute_days, minutes=1)
    assert await S.resolve_session(db, token, settings, now=past_absolute) is None


async def test_idle_slides_on_resolve(db, settings):
    u = await _user(db)
    now = utc()
    token, row = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    first_idle = row.idle_expires_at
    await S.resolve_session(db, token, settings, now=now + timedelta(hours=1))
    await db.commit()
    await db.refresh(row)
    assert row.idle_expires_at > first_idle


async def test_last_seen_throttled_within_window(db, settings):
    u = await _user(db)
    now = utc()
    token, row = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    created_last_seen = row.last_seen_at
    # resolve within the throttle window -> last_seen must NOT move
    await S.resolve_session(db, token, settings, now=now + timedelta(minutes=1))
    await db.commit()
    await db.refresh(row)
    assert row.last_seen_at == created_last_seen


async def test_last_seen_bumps_past_throttle(db, settings):
    u = await _user(db)
    now = utc()
    token, row = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    created_last_seen = row.last_seen_at
    # resolve past the throttle window -> last_seen advances
    later = now + timedelta(minutes=settings.last_seen_throttle_min + 1)
    await S.resolve_session(db, token, settings, now=later)
    await db.commit()
    await db.refresh(row)
    assert row.last_seen_at > created_last_seen


async def test_revoke_user_sessions_clears_all(db, settings):
    u = await _user(db)
    now = utc()
    await S.create_session(db, u.id, settings, now=now)
    await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    n = await S.revoke_user_sessions(db, u.id)
    await db.commit()
    assert n == 2


async def test_revoke_user_sessions_can_keep_one(db, settings):
    u = await _user(db)
    now = utc()
    keep_token, keep_row = await S.create_session(db, u.id, settings, now=now)
    await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    n = await S.revoke_user_sessions(db, u.id, except_token_hash=keep_row.token_hash)
    await db.commit()
    assert n == 1
    assert await S.resolve_session(db, keep_token, settings, now=now + timedelta(minutes=1)) is not None


async def test_purge_expired(db, settings):
    u = await _user(db)
    now = utc()
    await S.create_session(db, u.id, settings, now=now - timedelta(days=40))  # already past absolute
    await db.commit()
    n = await S.purge_expired(db, now=now)
    await db.commit()
    assert n == 1
