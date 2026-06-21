import pytest


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
    assert r.status_code in (200, 204)


@pytest.mark.asyncio
async def test_other_users_conversation_is_404(client_prd_ask, other_users_conversation_id):
    r = await client_prd_ask.get(f"/api/chat/conversations/{other_users_conversation_id}")
    assert r.status_code == 404  # not 403 — never leak existence
