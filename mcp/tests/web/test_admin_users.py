import pytest
from sqlalchemy import select

from prd_mcp.web.models import Role, User


async def _login_admin(client, settings):
    r = await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    assert r.status_code == 200


async def _role_id(sessionmaker_, name) -> str:
    async with sessionmaker_() as s:
        role = (await s.execute(select(Role).where(Role.name == name))).scalar_one()
        return str(role.id)


async def _make_pending(sessionmaker_, email, hasher_hash="x") -> str:
    async with sessionmaker_() as s:
        u = User(email=email, password_hash=hasher_hash, status="pending")
        s.add(u)
        await s.commit()
        await s.refresh(u)
        return str(u.id)


async def test_list_users_requires_permission(client):
    r = await client.get("/api/admin/users")
    assert r.status_code == 401  # no session


async def test_admin_can_list_users(client, settings):
    await _login_admin(client, settings)
    r = await client.get("/api/admin/users")
    assert r.status_code == 200
    assert any(u["email"].lower() == settings.admin_email.lower() for u in r.json()["users"])


async def test_approve_pending_assigns_member_role(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    uid = await _make_pending(sessionmaker_, "pend@ringkas.co.id")
    member_id = await _role_id(sessionmaker_, "member")
    r = await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    assert r.status_code == 200
    assert r.json()["status"] == "active"
    assert "prd.read" in r.json()["permissions"]


async def test_approve_with_half_admin_role_set_is_422(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    uid = await _make_pending(sessionmaker_, "halfp@ringkas.co.id")
    # build a custom role with only roles.manage to attempt a half-admin assignment
    async with sessionmaker_() as s:
        from prd_mcp.web.models import Permission
        rm = (await s.execute(select(Permission).where(Permission.name == "roles.manage"))).scalar_one()
        bad = Role(name="only_roles_manage")
        bad.permissions.append(rm)
        s.add(bad)
        await s.commit()
        await s.refresh(bad)
        bad_id = str(bad.id)
    r = await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [bad_id]})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "admin_pair"


async def test_approve_non_pending_user_is_409(client, settings, sessionmaker_):
    """approve is pending->active ONLY; re-approving an active user is rejected."""
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "twice@ringkas.co.id")
    first = await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    assert first.status_code == 200
    again = await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "invalid_state"


async def test_approve_persists_after_commit(client, settings, sessionmaker_):
    """The approval must be committed (get_db only yields) — re-read sees active."""
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "persist@ringkas.co.id")
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    async with sessionmaker_() as s:
        u = (await s.execute(select(User).where(User.email == "persist@ringkas.co.id"))).scalar_one()
        assert u.status == "active"
        assert u.approved_at is not None
        assert u.approved_by is not None  # spec §4: approver recorded


async def test_reject_non_pending_user_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "rejactive@ringkas.co.id")
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    r = await client.post(f"/api/admin/users/{uid}/reject")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "invalid_state"


async def test_enable_pending_user_is_409(client, settings, sessionmaker_):
    """enable is disabled->active ONLY; a pending user must go through approve."""
    await _login_admin(client, settings)
    uid = await _make_pending(sessionmaker_, "enpend@ringkas.co.id")
    r = await client.post(f"/api/admin/users/{uid}/enable")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "invalid_state"


async def test_disable_then_enable_round_trips(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    # second admin so we can disable a non-last-admin member
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "rt@ringkas.co.id")
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    dis = await client.post(f"/api/admin/users/{uid}/disable")
    assert dis.status_code == 200 and dis.json()["status"] == "disabled"
    en = await client.post(f"/api/admin/users/{uid}/enable")
    assert en.status_code == 200 and en.json()["status"] == "active"


async def test_disable_last_admin_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    async with sessionmaker_() as s:
        admin = (await s.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
        admin_id = str(admin.id)
    r = await client.post(f"/api/admin/users/{admin_id}/disable")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "last_admin"


async def test_disable_revokes_sessions(app, client, settings, sessionmaker_):
    import uuid as _uuid
    import httpx
    from sqlalchemy import select
    from prd_mcp.web.models import Session as SessionRow

    await _login_admin(client, settings)
    # create a SECOND admin so disabling them doesn't trip the last-admin invariant
    admin_role_id = await _role_id(sessionmaker_, "admin")
    uid = await _make_pending(sessionmaker_, "second@ringkas.co.id")
    uid_u = _uuid.UUID(uid)
    # give the second admin a known password via reset-password, then approve as admin
    await client.post(f"/api/admin/users/{uid}/reset-password", json={"password": "second-admin-pw-1"})
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [admin_role_id]})

    # the second admin logs in on their own client -> a session row exists
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers={"X-Requested-With": "prd-app"}) as second:
        li = await second.post("/api/auth/login", json={"email": "second@ringkas.co.id", "password": "second-admin-pw-1"})
        assert li.status_code == 200
        async with sessionmaker_() as s:
            before = (await s.execute(select(SessionRow).where(SessionRow.user_id == uid_u))).scalars().all()
            assert len(before) >= 1

        # first admin disables the second -> their sessions are revoked, next request 401
        r = await client.post(f"/api/admin/users/{uid}/disable")
        assert r.status_code == 200 and r.json()["status"] == "disabled"
        async with sessionmaker_() as s:
            after = (await s.execute(select(SessionRow).where(SessionRow.user_id == uid_u))).scalars().all()
            assert len(after) == 0
        assert (await second.get("/api/auth/me")).status_code == 401


async def test_reject_pending_deletes(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    uid = await _make_pending(sessionmaker_, "rej@ringkas.co.id")
    r = await client.post(f"/api/admin/users/{uid}/reject")
    assert r.status_code == 200
    async with sessionmaker_() as s:
        assert (await s.execute(select(User).where(User.email == "rej@ringkas.co.id"))).scalar_one_or_none() is None


async def test_set_roles_replaces_and_invariant(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "sr@ringkas.co.id")
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    r = await client.put(f"/api/admin/users/{uid}/roles", json={"role_ids": []})
    assert r.status_code == 200
    assert r.json()["permissions"] == []


async def test_set_roles_removing_last_admin_is_409(client, settings, sessionmaker_):
    """Demoting the only admin via set-roles is rejected 409 last_admin."""
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    async with sessionmaker_() as s:
        admin = (await s.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
        admin_id = str(admin.id)
    # try to replace the admin's roles with member-only (drops the last admin)
    r = await client.put(f"/api/admin/users/{admin_id}/roles", json={"role_ids": [member_id]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "last_admin"


async def test_set_roles_removing_last_admin_is_409(client, settings, sessionmaker_):
    """Demoting the only admin via set-roles is rejected 409 last_admin."""
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    async with sessionmaker_() as s:
        admin = (await s.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
        admin_id = str(admin.id)
    r = await client.put(f"/api/admin/users/{admin_id}/roles", json={"role_ids": [member_id]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "last_admin"
