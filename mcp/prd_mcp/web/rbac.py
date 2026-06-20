"""The ONLY source of permission names and the authorization guards.

- PERMISSIONS: the fixed code-defined vocabulary.
- assert_pair_integrity: no role/user may hold exactly one of the admin pair.
- assert_admin_invariant: >=1 active user with BOTH admin-pair perms must remain.
- current_user / require_permission: per-request session + permission resolution.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Depends, Request
from sqlalchemy import func, select

from sqlalchemy import text

from prd_mcp.web.db import get_db
from prd_mcp.web.errors import forbidden, last_admin_error, pair_error, unauthorized
from prd_mcp.web.models import (
    Permission,
    Role,
    User,
    role_permissions,
    user_roles,
)
from prd_mcp.web import sessions as sessions_mod
from prd_mcp.web.settings import WebSettings

# Arbitrary fixed key for the transaction-scoped advisory lock that serializes
# the last-admin check-then-mutate across concurrent requests.
_ADMIN_INVARIANT_LOCK_KEY = 4827310199

PERMISSIONS: dict[str, str] = {
    "prd.read": "Read PRDs (Library + Search).",
    "prd.ask": "Ask tab (LLM-grounded answers).",
    "status.view": "Status tab (run health + coverage).",
    "users.manage": "View/approve/disable/delete users and assign their roles.",
    "roles.manage": "Create/edit/delete roles, set role permissions, change settings.",
}
ALL_PERMISSION_NAMES = frozenset(PERMISSIONS)
MEMBER_PERMISSION_NAMES = frozenset({"prd.read", "prd.ask"})
ADMIN_PAIR = frozenset({"users.manage", "roles.manage"})


def effective_permissions(user: User) -> set[str]:
    out: set[str] = set()
    for role in user.roles:
        for perm in role.permissions:
            out.add(perm.name)
    return out


def assert_pair_integrity(perm_names: set[str]) -> None:
    """Reject any permission set holding exactly one of the admin pair."""
    if len(set(perm_names) & ADMIN_PAIR) == 1:
        raise pair_error()


async def assert_admin_invariant(db) -> None:
    """>=1 active user whose EFFECTIVE permissions include BOTH admin-pair perms.

    SQL over the join tables so it sees flushed-but-uncommitted state in the
    current transaction. Counts users who, across all their roles, hold both.

    Concurrency: without serialization this is a TOCTOU — two requests each
    disabling a different admin can both observe the other still active and both
    commit, leaving zero admins. A transaction-scoped Postgres advisory lock
    serializes the check-then-mutate: the second request blocks until the first
    commits, then re-evaluates against the post-commit state. The lock auto-
    releases at txn end (commit OR rollback), so a rejected op holds nothing.
    Callers MUST run this AFTER their flush and BEFORE their commit.
    """
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)").bindparams(k=_ADMIN_INVARIANT_LOCK_KEY))
    pair = list(ADMIN_PAIR)
    stmt = (
        select(func.count())
        .select_from(
            select(User.id)
            .join(user_roles, user_roles.c.user_id == User.id)
            .join(role_permissions, role_permissions.c.role_id == user_roles.c.role_id)
            .join(Permission, Permission.id == role_permissions.c.permission_id)
            .where(User.status == "active", Permission.name.in_(pair))
            .group_by(User.id)
            .having(func.count(func.distinct(Permission.name)) == len(pair))
            .subquery()
        )
    )
    count = (await db.execute(stmt)).scalar_one()
    if count < 1:
        raise last_admin_error()


async def _load_active_user_by_session(request: Request, db, settings: WebSettings) -> tuple[User, str] | None:
    # Returns None for ALL of absent / expired / revoked / disabled-user, so
    # current_user raises ONE uniform 401 `unauthorized`. This is deliberate
    # (spec §9 groups "Expired/invalid/revoked session → 401, clears the cookie"
    # as a single outcome): a distinct `session_expired` code would leak whether
    # a token ever existed. Do NOT split these into separate codes.
    token = request.cookies.get(settings.cookie_name)
    if not token:
        return None
    now = datetime.now(timezone.utc)
    session_row = await sessions_mod.resolve_session(db, token, settings, now=now)
    if session_row is None:
        return None
    user = (await db.execute(select(User).where(User.id == session_row.user_id))).scalar_one_or_none()
    if user is None or user.status != "active":
        return None
    return user, session_row.token_hash


def get_settings(request: Request) -> WebSettings:
    return request.app.state.settings


async def current_user(
    request: Request,
    db=Depends(get_db),
    settings: WebSettings = Depends(get_settings),
) -> User:
    loaded = await _load_active_user_by_session(request, db, settings)
    if loaded is None:
        raise unauthorized()
    user, token_hash = loaded
    # resolve_session slid idle_expires_at (and maybe last_seen_at) but only
    # flushed. get_db does NOT commit on success, and read-only handlers (e.g.
    # /me) never commit, so without this the slide rolls back and the idle window
    # never actually moves in production (spec §4 requires it to slide on
    # activity). Commit the slide here; mutating handlers commit again later,
    # which is a harmless no-op on an already-committed slide.
    await db.commit()
    request.state.session_token_hash = token_hash
    request.state.current_user = user
    return user


def require_permission(name: str):
    async def _dep(user: User = Depends(current_user)) -> User:
        if name not in effective_permissions(user):
            raise forbidden()
        return user

    return _dep
