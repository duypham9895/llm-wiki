"""Notification router: list, mark-read, mark-all-read, gating, isolation.

Uses the real-Postgres fixtures (testcontainers) so the
notifications.user_id FK + cascade-delete behave the same as prod.
"""
from __future__ import annotations

import pytest

from prd_mcp.web.models import Notification, Role


@pytest.mark.asyncio
async def test_list_requires_prd_read(client_no_perms):
    r = await client_no_perms.get("/api/notifications")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_list_returns_only_own_notifications(client_prd_read, db):
    """User A's notifications must not appear in user B's list."""
    from tests.web.conftest import make_user_with_perms

    other = await make_user_with_perms(db, "other@ringkas.co.id", {"prd.read"})
    await db.commit()

    db.add_all(
        [
            Notification(user_id=client_prd_read._transport.app.state._me_id if False else None,  # placeholder
                          kind="system", title="mine", body=""),
        ]
    ) if False else None

    # Plant rows for BOTH users directly via the DB.
    me_id = (
        await db.execute(
            __import__("sqlalchemy").text(
                "SELECT id FROM users WHERE email = 'reader@ringkas.co.id'"
            )
        )
    ).scalar_one()
    db.add_all([
        Notification(user_id=me_id, kind="system", title="for me", body="mine"),
        Notification(user_id=other.id, kind="system", title="for other", body="theirs"),
    ])
    await db.commit()

    r = await client_prd_read.get("/api/notifications")
    assert r.status_code == 200
    body = r.json()
    titles = [n["title"] for n in body["notifications"]]
    assert "for me" in titles
    assert "for other" not in titles
    assert body["unread_count"] == 1


@pytest.mark.asyncio
async def test_mark_read_flips_read_at(client_prd_read, db):
    import sqlalchemy as sa

    me_id = (
        await db.execute(
            sa.text("SELECT id FROM users WHERE email = 'reader@ringkas.co.id'")
        )
    ).scalar_one()
    n = Notification(user_id=me_id, kind="system", title="hi", body="x")
    db.add(n)
    await db.commit()
    await db.refresh(n)

    assert n.read_at is None
    r = await client_prd_read.post(f"/api/notifications/{n.id}/read")
    assert r.status_code == 200
    await db.refresh(n)
    assert n.read_at is not None


@pytest.mark.asyncio
async def test_mark_read_other_users_notification_404(client_prd_read, db):
    """Cannot mark another user's notification as read — must 404, not 403,
    so the endpoint can't be used to probe notification ids."""
    from tests.web.conftest import make_user_with_perms

    other = await make_user_with_perms(db, "other2@ringkas.co.id", {"prd.read"})
    await db.commit()
    n = Notification(user_id=other.id, kind="system", title="private", body="")
    db.add(n)
    await db.commit()
    await db.refresh(n)

    r = await client_prd_read.post(f"/api/notifications/{n.id}/read")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_mark_all_read_clears_unread(client_prd_read, db):
    import sqlalchemy as sa

    me_id = (
        await db.execute(
            sa.text("SELECT id FROM users WHERE email = 'reader@ringkas.co.id'")
        )
    ).scalar_one()
    db.add_all([
        Notification(user_id=me_id, kind="system", title=f"n{i}", body="") for i in range(3)
    ])
    await db.commit()

    r = await client_prd_read.post("/api/notifications/read_all")
    assert r.status_code == 200
    assert r.json()["marked"] == 3

    r = await client_prd_read.get("/api/notifications")
    assert r.json()["unread_count"] == 0


@pytest.mark.asyncio
async def test_notify_admins_fans_out_to_active_admin(db, settings):
    """notify_admins writes to every ACTIVE user holding the admin role."""
    from tests.web.conftest import make_user_with_perms
    from prd_mcp.web.notifications import notify_admins

    # Pending admin must NOT be notified.
    pending_admin = await make_user_with_perms(db, "pending-admin@ringkas.co.id",
                                               {"users.manage", "roles.manage"}, status="pending")
    # Active admin MUST be notified.
    active_admin = await make_user_with_perms(db, "active-admin@ringkas.co.id",
                                              {"users.manage", "roles.manage"}, status="active")
    # Active non-admin MUST NOT be notified.
    active_reader = await make_user_with_perms(db, "active-reader@ringkas.co.id",
                                              {"prd.read"}, status="active")
    await db.commit()

    n = await notify_admins(db, kind="sync_failed", title="Notion sync failed", body="boom")
    assert n == 1  # only the active admin

    # Verify by user_id.
    import sqlalchemy as sa
    rows = (await db.execute(
        sa.select(Notification.user_id, Notification.read_at)
    )).all()
    notified_ids = {row[0] for row in rows}
    assert active_admin.id in notified_ids
    assert pending_admin.id not in notified_ids
    assert active_reader.id not in notified_ids
    assert all(row[1] is None for row in rows)  # unread