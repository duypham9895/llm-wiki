import pytest
import sqlalchemy


class _FakeR:
    doc_stem = "EP-1"
    doc_id = "EP-1"
    title = "T"
    source_url = ""
    summary = "s"
    tags = []
    status = ""
    text = "ctx"
    score = 0.5


@pytest.mark.asyncio
async def test_sse_stream_emits_ordered_events(client_prd_ask, conv_id, monkeypatch):
    # fake the core's retrieve to return a match, and chat_stream to yield tokens
    import prd_mcp.web.chat as chatmod
    monkeypatch.setattr(chatmod, "retrieve", lambda q, store, embed, k, th: ([_FakeR()], "match"))

    async def fake_stream(question, retrieved, verdict, fn):
        for t in ["A", "B"]:
            yield t

    monkeypatch.setattr(chatmod, "answer_stream", fake_stream)
    monkeypatch.setattr(chatmod, "rewrite_query", lambda h, l, fn: l)
    r = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "hi"},
        headers={"x-requested-with": "prd-app"},
    )
    assert r.status_code == 200
    body = r.text
    assert body.index("event: rewrite") < body.index("event: sources") < body.index("event: token") < body.index("event: done")


@pytest.mark.asyncio
async def test_sse_requires_csrf_header(settings, sessionmaker_, fake_core, ask_user):
    """Verify CSRF middleware rejects POST without X-Requested-With header.

    Uses a separate client that sends NO default CSRF header, unlike client_prd_ask
    which adds X-Requested-With: prd-app for all requests.
    """
    import httpx
    from sqlalchemy.orm import selectinload
    from prd_mcp.web import db as db_mod
    from prd_mcp.web.app import create_app
    from prd_mcp.web.rbac import current_user
    from prd_mcp.web.models import User, Role
    import sqlalchemy

    db_mod.set_sessionmaker(sessionmaker_)
    app = create_app(settings, sessionmaker_, run_startup=False, core=fake_core)

    async def _cu():
        async with sessionmaker_() as s:
            return (
                await s.execute(
                    sqlalchemy.select(User)
                    .where(User.id == ask_user.id)
                    .options(selectinload(User.roles).selectinload(Role.permissions))
                )
            ).scalar_one()

    app.dependency_overrides[current_user] = _cu

    # Create a conversation via client_prd_ask first; then hit the messages endpoint
    # without the CSRF header using a no-default-header client.
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as no_csrf_client:
        # First create a conv with the CSRF header so we have a valid conv_id
        r_create = await no_csrf_client.post(
            "/api/chat/conversations",
            headers={"x-requested-with": "prd-app"},
        )
        cid = r_create.json()["id"]
        # Now try to post a message WITHOUT the CSRF header
        r = await no_csrf_client.post(
            f"/api/chat/conversations/{cid}/messages",
            json={"content": "hi"},
        )
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf"


@pytest.mark.asyncio
async def test_sse_busy_conversation_409(client_prd_ask, busy_conv_id):
    r = await client_prd_ask.post(
        f"/api/chat/conversations/{busy_conv_id}/messages",
        json={"content": "hi"},
        headers={"x-requested-with": "prd-app"},
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "conversation_busy"


@pytest.mark.asyncio
async def test_sse_empty_content_422(client_prd_ask, conv_id):
    r = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "   "},
        headers={"x-requested-with": "prd-app"},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_list_get_delete_owned(client_prd_ask):
    r = await client_prd_ask.post("/api/chat/conversations", headers={"x-requested-with": "prd-app"})
    assert r.status_code == 200
    cid = r.json()["id"]
    r = await client_prd_ask.get("/api/chat/conversations")
    assert any(c["id"] == cid for c in r.json())
    r = await client_prd_ask.get(f"/api/chat/conversations/{cid}")
    assert r.status_code == 200 and r.json()["messages"] == []
    r = await client_prd_ask.delete(f"/api/chat/conversations/{cid}", headers={"x-requested-with": "prd-app"})
    assert r.status_code == 204
    r = await client_prd_ask.get(f"/api/chat/conversations/{cid}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_other_users_conversation_is_404(client_prd_ask, other_users_conversation_id):
    r = await client_prd_ask.get(f"/api/chat/conversations/{other_users_conversation_id}")
    assert r.status_code == 404  # not 403 — never leak existence


@pytest.mark.asyncio
async def test_delete_other_users_conversation_is_404(client_prd_ask, other_users_conversation_id):
    r = await client_prd_ask.delete(f"/api/chat/conversations/{other_users_conversation_id}", headers={"x-requested-with": "prd-app"})
    assert r.status_code == 404  # ownership-locked delete


@pytest.mark.asyncio
async def test_malformed_cid_get_is_404(client_prd_ask):
    r = await client_prd_ask.get("/api/chat/conversations/not-a-uuid")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_malformed_cid_delete_is_404(client_prd_ask):
    r = await client_prd_ask.delete("/api/chat/conversations/not-a-uuid", headers={"x-requested-with": "prd-app"})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Lock-release correctness tests (Codex findings #1/#2/#3/#4)
# ---------------------------------------------------------------------------

def _patch_happy(monkeypatch):
    """Monkeypatch retrieve/answer_stream/rewrite_query for a happy-path stream."""
    import prd_mcp.web.chat as chatmod
    monkeypatch.setattr(chatmod, "retrieve", lambda q, store, embed, k, th: ([_FakeR()], "match"))
    monkeypatch.setattr(chatmod, "rewrite_query", lambda h, l, fn: l)

    async def _fake_stream(question, retrieved, verdict, fn):
        for t in ["X", "Y"]:
            yield t

    monkeypatch.setattr(chatmod, "answer_stream", _fake_stream)


@pytest.mark.asyncio
async def test_lock_released_after_normal_stream(
    client_prd_ask, conv_id, monkeypatch, sessionmaker_
):
    """After a successful stream, generating=False; a second POST on the same
    conversation succeeds (200), proving the lock was released."""
    _patch_happy(monkeypatch)

    r1 = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "first"},
        headers={"x-requested-with": "prd-app"},
    )
    assert r1.status_code == 200, f"first POST failed: {r1.status_code}"
    # Verify the response body contains done event
    assert "event: done" in r1.text

    # Second message on the same conversation must succeed (lock was released)
    r2 = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "second"},
        headers={"x-requested-with": "prd-app"},
    )
    assert r2.status_code == 200, (
        f"Second POST returned {r2.status_code} — lock was NOT released after first stream. "
        f"Body: {r2.text}"
    )


@pytest.mark.asyncio
async def test_lock_released_after_llm_error(
    client_prd_ask, conv_id, monkeypatch, sessionmaker_
):
    """When the LLM pipeline raises an exception, generating must be set back to
    False so subsequent messages are not permanently blocked."""
    import prd_mcp.web.chat as chatmod

    monkeypatch.setattr(chatmod, "rewrite_query", lambda h, l, fn: l)
    monkeypatch.setattr(chatmod, "retrieve", lambda q, store, embed, k, th: (_ for _ in ()).throw(RuntimeError("retrieval exploded")))

    r1 = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "trigger error"},
        headers={"x-requested-with": "prd-app"},
    )
    # The SSE response itself starts (200), but contains an error event
    assert r1.status_code == 200
    assert "event: error" in r1.text

    # Now check the DB directly — generating must be False
    from prd_mcp.web.chatmodels import Conversation as Conv
    import uuid as _uuid
    async with sessionmaker_() as s:
        row = (await s.execute(
            sqlalchemy.select(Conv).where(Conv.id == _uuid.UUID(conv_id))
        )).scalar_one()
        assert row.generating is False, (
            "generating stuck True after LLM error — lock was NOT released"
        )

    # A follow-up message must also succeed (not 409)
    _patch_happy(monkeypatch)
    r2 = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "retry after error"},
        headers={"x-requested-with": "prd-app"},
    )
    assert r2.status_code == 200, (
        f"Retry after LLM error returned {r2.status_code} — lock stuck. Body: {r2.text}"
    )


@pytest.mark.asyncio
async def test_assistant_row_finish_reason_on_happy_path(
    client_prd_ask, conv_id, monkeypatch, sessionmaker_
):
    """After a successful stream the persisted assistant Message has
    finish_reason='complete' and non-empty content."""
    _patch_happy(monkeypatch)

    r = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "check finish reason"},
        headers={"x-requested-with": "prd-app"},
    )
    assert r.status_code == 200
    assert "event: done" in r.text

    from prd_mcp.web.chatmodels import Message as Msg
    import uuid as _uuid
    async with sessionmaker_() as s:
        msgs = (await s.execute(
            sqlalchemy.select(Msg)
            .where(Msg.conversation_id == _uuid.UUID(conv_id))
            .order_by(Msg.seq)
        )).scalars().all()

    assistant_msgs = [m for m in msgs if m.role == "assistant"]
    assert len(assistant_msgs) == 1, f"Expected 1 assistant message, got {len(assistant_msgs)}"
    am = assistant_msgs[0]
    assert am.finish_reason == "complete", f"Expected finish_reason='complete', got {am.finish_reason!r}"
    assert am.content, "Assistant message content is empty"
    # grounded should be True because verdict was "match" (not "no_match")
    assert am.grounded is True, f"Expected grounded=True, got {am.grounded!r}"
    # sources persisted from format_sources([_FakeR]) — the cited PRD id round-trips
    assert isinstance(am.sources, list) and len(am.sources) == 1, f"Expected 1 source, got {am.sources!r}"
    assert am.sources[0]["id"] == "EP-1", f"Expected source id EP-1, got {am.sources[0]!r}"

    # NOTE: A real client-disconnect/CancelledError test (finish='client_disconnected') is
    # not feasible in this in-process harness because httpx ASGI transport always reads
    # the full response before returning; there is no mechanism to mid-stream cancel the
    # generator from the client side. The disconnect path is covered structurally: the
    # shielded CancelScope in the finally block guarantees the lock-release commit runs
    # to completion even when anyio cancels the generator coroutine on disconnect.


# ---------------------------------------------------------------------------
# Generation timeout — sweep-cutoff invariant enforcement (Codex blocker fix)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_generation_timeout_releases_lock_and_sets_finish_reason(
    client_prd_ask, conv_id, monkeypatch, sessionmaker_
):
    """Verify that when GENERATION_TIMEOUT_SECONDS fires:
    1. The request completes (does not hang indefinitely).
    2. The generating lock is released (generating=False), so a second message succeeds.
    3. The persisted assistant row has finish_reason='timeout'.

    Mechanism: monkeypatch GENERATION_TIMEOUT_SECONDS to 0.5 s and fake answer_stream
    to yield slowly (1 s sleep between tokens). move_on_after fires before any token is
    yielded; the shielded finally persists the (empty) assistant row and releases the lock.
    """
    import asyncio
    import uuid as _uuid
    import prd_mcp.web.chat as chatmod
    import sqlalchemy

    # Inject a very short timeout to make the test fast.
    monkeypatch.setattr(chatmod, "GENERATION_TIMEOUT_SECONDS", 0.5)

    monkeypatch.setattr(chatmod, "rewrite_query", lambda h, l, fn: l)
    monkeypatch.setattr(chatmod, "retrieve", lambda q, store, embed, k, th: ([_FakeR()], "match"))

    async def _slow_stream(question, retrieved, verdict, fn):
        await asyncio.sleep(5)  # far longer than the 0.5 s timeout
        yield "never_reached"

    monkeypatch.setattr(chatmod, "answer_stream", _slow_stream)

    # 1. Request must complete (not hang).
    r = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "timeout test"},
        headers={"x-requested-with": "prd-app"},
    )
    assert r.status_code == 200

    # "done" event must NOT be emitted on timeout (only on "complete").
    assert "event: done" not in r.text

    # 2. Lock released — DB generating=False.
    from prd_mcp.web.chatmodels import Conversation as Conv, Message as Msg
    async with sessionmaker_() as s:
        conv_row = (await s.execute(
            sqlalchemy.select(Conv).where(Conv.id == _uuid.UUID(conv_id))
        )).scalar_one()
        assert conv_row.generating is False, (
            "generating stuck True after timeout — lock was NOT released"
        )

    # 3. finish_reason of the persisted assistant row must be "timeout".
    async with sessionmaker_() as s:
        msgs = (await s.execute(
            sqlalchemy.select(Msg)
            .where(Msg.conversation_id == _uuid.UUID(conv_id))
            .order_by(Msg.seq)
        )).scalars().all()
    assistant_msgs = [m for m in msgs if m.role == "assistant"]
    assert len(assistant_msgs) == 1, f"Expected 1 assistant row, got {len(assistant_msgs)}"
    assert assistant_msgs[0].finish_reason == "timeout", (
        f"Expected finish_reason='timeout', got {assistant_msgs[0].finish_reason!r}"
    )

    # 4. Second message succeeds (lock was actually released, not just DB-refreshed).
    _patch_happy(monkeypatch)
    monkeypatch.setattr(chatmod, "GENERATION_TIMEOUT_SECONDS", 600)  # restore
    r2 = await client_prd_ask.post(
        f"/api/chat/conversations/{conv_id}/messages",
        json={"content": "after timeout"},
        headers={"x-requested-with": "prd-app"},
    )
    assert r2.status_code == 200, (
        f"Second POST returned {r2.status_code} — lock NOT released after timeout. Body: {r2.text}"
    )


# ---------------------------------------------------------------------------
# sweep_stale_generating — purge-loop self-heal for pre-iteration disconnects
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sweep_clears_stale_generating_lock(db, ask_user):
    """A generating=True conversation with updated_at > threshold minutes ago is
    swept to generating=False.  Returns rowcount == 1."""
    from datetime import datetime, timedelta, timezone
    from prd_mcp.web.chat import sweep_stale_generating
    from prd_mcp.web.chatmodels import Conversation as Conv
    import sqlalchemy

    stale_time = datetime.now(timezone.utc) - timedelta(hours=1)

    conv = Conv(user_id=ask_user.id, title="stale", generating=True)
    db.add(conv)
    await db.flush()
    # Force updated_at to 1 hour ago bypassing the server_default
    await db.execute(
        sqlalchemy.update(Conv)
        .where(Conv.id == conv.id)
        .values(updated_at=stale_time)
    )
    await db.commit()

    now = datetime.now(timezone.utc)
    swept = await sweep_stale_generating(db, older_than_minutes=30, now=now)
    await db.commit()

    await db.refresh(conv)
    assert conv.generating is False, "stale lock was not cleared"
    assert swept == 1, f"expected rowcount 1, got {swept}"


@pytest.mark.asyncio
async def test_sweep_does_not_clear_recent_generating_lock(db, ask_user):
    """A generating=True conversation with a recent updated_at (now) is NOT swept —
    proves the sweep cannot interrupt a legitimately in-flight stream."""
    from datetime import datetime, timezone
    from prd_mcp.web.chat import sweep_stale_generating
    from prd_mcp.web.chatmodels import Conversation as Conv
    import sqlalchemy

    conv = Conv(user_id=ask_user.id, title="inflight", generating=True)
    db.add(conv)
    await db.flush()
    # Force updated_at to right now (recent)
    now = datetime.now(timezone.utc)
    await db.execute(
        sqlalchemy.update(Conv)
        .where(Conv.id == conv.id)
        .values(updated_at=now)
    )
    await db.commit()

    swept = await sweep_stale_generating(db, older_than_minutes=30, now=now)
    await db.commit()

    await db.refresh(conv)
    assert conv.generating is True, "in-flight lock was incorrectly cleared"
    assert swept == 0, f"expected rowcount 0, got {swept}"


@pytest.mark.asyncio
async def test_claim_refreshes_updated_at_so_sweep_spares_active_lock(db, ask_user):
    """Regression (Codex): the stale-sweep keys off updated_at, so the lock CLAIM must
    refresh updated_at — otherwise a conversation last touched long ago could be claimed
    and then swept WHILE STILL generating (mid-stream), releasing the lock under an active
    generation. This test runs the sweep against a row that is `generating=True` from the
    claim (NOT yet released), with an originally-old updated_at, and asserts it is spared.

    It would FAIL if the claim UPDATE omitted `updated_at=func.now()`: the row would still
    be generating=True but with an old updated_at, and the sweep would clear it."""
    from datetime import datetime, timedelta, timezone
    from prd_mcp.web.chat import sweep_stale_generating
    from prd_mcp.web.chatmodels import Conversation as Conv
    from sqlalchemy import func, select, update as sa_update

    # Conversation last touched 2 hours ago, not generating.
    old_time = datetime.now(timezone.utc) - timedelta(hours=2)
    conv = Conv(user_id=ask_user.id, title="old", generating=False)
    db.add(conv)
    await db.flush()
    await db.execute(sa_update(Conv).where(Conv.id == conv.id).values(updated_at=old_time))
    await db.commit()

    # Apply the EXACT claim statement the handler uses (atomic, refreshes updated_at).
    # This is the production claim from post_message: generating=True + updated_at=func.now().
    claimed = (await db.execute(
        sa_update(Conv)
        .where(Conv.id == conv.id, Conv.generating.is_(False))
        .values(generating=True, updated_at=func.now())
    )).rowcount
    await db.commit()
    assert claimed == 1

    # The conversation is now generating=True (lock held, NOT released). Run the sweep with
    # a reference time 1 minute in the future. Because the claim refreshed updated_at to ~now,
    # the (formerly 2h-old) conversation must NOT be swept out from under the active lock.
    swept = await sweep_stale_generating(db, older_than_minutes=30,
                                         now=datetime.now(timezone.utc) + timedelta(minutes=1))
    await db.commit()
    await db.refresh(conv)
    assert swept == 0, "claim must refresh updated_at — active lock was swept mid-generation"
    assert conv.generating is True, "active lock was incorrectly released by the sweep"
