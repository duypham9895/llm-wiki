"""In-app notifications router + the helpers that write them.

Routes (all require `prd.read` — any authed user can see their own):
- GET    /api/notifications          — current user's last 20, newest first
                                        (paginate older via ?before_id=)
- POST   /api/notifications/{id}/read — mark one as read
- POST   /api/notifications/read_all  — mark every unread for the current user

Writers (`notify_admins` / `notify_user`) live here so the sync CLI can
fan-out `sync_failed` alerts without importing the rest of the web layer.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from prd_mcp.web.db import get_db
from prd_mcp.web.models import Notification, Permission, Role, User, role_permissions, user_roles
from prd_mcp.web.rbac import ADMIN_PAIR, current_user, require_permission

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

NotificationKind = Literal["sync_failed", "prd_added", "prd_edited", "system"]
_PAGE_SIZE = 20


class NotificationOut(BaseModel):
    id: int
    kind: str
    title: str
    body: str
    link: str | None
    read_at: datetime | None
    created_at: datetime


class NotificationListOut(BaseModel):
    notifications: list[NotificationOut]
    unread_count: int
    next_before_id: int | None


def _to_out(n: Notification) -> NotificationOut:
    return NotificationOut(
        id=n.id,
        kind=n.kind,
        title=n.title,
        body=n.body,
        link=n.link,
        read_at=n.read_at,
        created_at=n.created_at,
    )


# ---- writers ----


async def notify_admins(db, *, kind: NotificationKind, title: str, body: str = "", link: str | None = None) -> int:
    """Fan-out a notification to every ACTIVE user whose effective perms include
    BOTH halves of the admin pair (matches `assert_admin_invariant`'s definition
    of an admin — role-name-agnostic so custom admin roles also qualify).

    Returns the number of rows written. Used by `sources.py` on sync failure.
    Single-round-trip Postgres `INSERT ... SELECT`; notifications are an
    append-only stream, so duplicate alerts are intentional.
    """
    # Pick user_ids whose union of role-granted permissions contains BOTH
    # 'users.manage' AND 'roles.manage'. DISTINCT on user_id, then require
    # the count of distinct admin-pair perms to equal 2.
    admin_pair_names = sorted(ADMIN_PAIR)
    admin_perm_subq = (
        select(user_roles.c.user_id)
        .join(role_permissions, role_permissions.c.role_id == user_roles.c.role_id)
        .join(Permission, Permission.id == role_permissions.c.permission_id)
        .where(Permission.name.in_(admin_pair_names))
        .group_by(user_roles.c.user_id)
        .having(func.count(func.distinct(Permission.name)) == len(admin_pair_names))
        .subquery()
    )
    stmt = pg_insert(Notification).from_select(
        ["user_id", "kind", "title", "body", "link"],
        select(User.id, sa_literal(kind), sa_literal(title), sa_literal(body), sa_literal(link))
        .where(User.id.in_(select(admin_perm_subq.c.user_id)), User.status == "active"),
    )
    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount or 0


async def notify_user(db, *, user_id, kind: NotificationKind, title: str, body: str = "", link: str | None = None) -> int:
    """Single-user variant. Returns 1 on insert, 0 otherwise."""
    db.add(Notification(user_id=user_id, kind=kind, title=title, body=body, link=link))
    await db.commit()
    return 1


# Small helper: SQL literal wrapper around bound params for use inside from_select.
from sqlalchemy import literal as sa_literal  # noqa: E402  (placed after use for readability)


# ---- routes ----


@router.get("", response_model=NotificationListOut)
async def list_notifications(
    before_id: int | None = Query(None, ge=1, description="Return rows with id < before_id (pagination)"),
    user: User = Depends(require_permission("prd.read")),
    db=Depends(get_db),
):
    """Return the current user's most-recent notifications, newest first.

    Pagination: when the page fills, the LAST row's id is returned as
    `next_before_id`. The UI passes that on the next request to keep scrolling
    back through history without offset drift.
    """
    base = select(Notification).where(Notification.user_id == user.id)
    if before_id is not None:
        base = base.where(Notification.id < before_id)
    rows = (
        await db.execute(base.order_by(Notification.id.desc()).limit(_PAGE_SIZE))
    ).scalars().all()

    unread = (
        await db.execute(
            select(Notification.id)
            .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        )
    ).scalars().all()

    next_cursor = rows[-1].id if len(rows) == _PAGE_SIZE else None
    return NotificationListOut(
        notifications=[_to_out(r) for r in rows],
        unread_count=len(unread),
        next_before_id=next_cursor,
    )


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: int,
    user: User = Depends(require_permission("prd.read")),
    db=Depends(get_db),
):
    """Mark ONE notification as read. Idempotent — re-marking a read row is a no-op.

    Scoped to the current user: a 404 (not a 403) is returned when the row
    belongs to someone else, so this endpoint can't be used to probe notification ids.
    """
    result = await db.execute(
        update(Notification)
        .where(
            Notification.id == notification_id,
            Notification.user_id == user.id,
            Notification.read_at.is_(None),
        )
        .values(read_at=datetime.now(timezone.utc))
    )
    await db.commit()
    # If the row exists but was already read, result.rowcount is 0 — still 200,
    # because the desired state is achieved.
    if result.rowcount == 0:
        # Distinguish "not yours / not found" from "already read" without
        # exposing existence: probe the row scoped to the user.
        exists = (
            await db.execute(
                select(Notification.id).where(
                    Notification.id == notification_id, Notification.user_id == user.id
                )
            )
        ).scalar_one_or_none()
        if exists is None:
            from prd_mcp.web.errors import AppError

            raise AppError(404, "not_found", "notification not found")
    return {"status": "ok"}


@router.post("/read_all")
async def mark_all_read(
    user: User = Depends(require_permission("prd.read")),
    db=Depends(get_db),
):
    """Mark every UNREAD notification for the current user as read.

    Used by the dropdown's "Mark all as read" footer link.
    """
    result = await db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=datetime.now(timezone.utc))
    )
    await db.commit()
    return {"status": "ok", "marked": result.rowcount or 0}


# ADMIN_PAIR import kept available so future admin-targeted writes (e.g.
# `notify_user_by_perm`) can reuse the constant without re-importing rbac.
_ = ADMIN_PAIR