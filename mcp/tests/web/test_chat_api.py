import pytest


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
