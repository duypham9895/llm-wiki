"""Tests for the new `GET /api/prd/_health/postgres` endpoint.

Mirrors the structure used by other web tests: real testcontainers Postgres
via the shared `engine` / `sessionmaker_` / `db` fixtures, real RBAC checks,
a per-test app built from `create_app(...)` so dependency overrides don't
bleed. Uses `httpx.AsyncClient` against the in-process ASGI app — same
pattern as tests/web/test_chat_api.py.

We do NOT mock the DB to fake "fast": the testcontainers Postgres inside the
test runner is fast enough (single-digit ms) that the ok-path latency
assertion is just `>= 0`. The "slow" case patches `time.monotonic` on the
prd module so we don't actually sleep the test runner.
"""
from __future__ import annotations

import httpx
import pytest
import sqlalchemy
from sqlalchemy.orm import selectinload

from prd_mcp.web import db as db_mod
from prd_mcp.web.coredeps import Core
from prd_mcp.web.models import Role, Permission, User
from prd_mcp.web.rbac import current_user


# ---- shared helpers ---------------------------------------------------------

class _StubStore:
    def stored_hashes(self):
        return set()

    def list_cards(self, status=None, tag=None, cursor=None, limit=50):
        return {"results": [], "next_cursor": None}


class _StubLlm:
    def embed(self, texts):
        return [[0.1, 0.2]]

    def chat(self, messages):
        return "ok"

    async def chat_stream(self, messages, **kw):
        for token in ["a"]:
            yield token


class _StubCfg:
    prds_dir = "/tmp/prds"
    score_threshold = -0.15
    top_k = 8
    vault_path = "/tmp/vault"
    chroma_path = "/tmp/chroma"


def _stub_core() -> Core:
    return Core(cfg=_StubCfg(), store=_StubStore(), llm=_StubLlm())


async def _make_user(db, email: str, perms: set) -> User:
    user = User(email=email, password_hash="x", status="active")
    if perms:
        role = Role(name=f"role_{email.split('@')[0]}")
        for name in sorted(perms):
            existing = (
                await db.execute(
                    sqlalchemy.select(Permission).where(Permission.name == name)
                )
            ).scalar_one_or_none()
            role.permissions.append(
                existing if existing is not None else Permission(name=name)
            )
        user.roles.append(role)
        db.add(role)
    db.add(user)
    await db.flush()
    return user


def _build_app(settings, sessionmaker_):
    from prd_mcp.web.app import create_app

    db_mod.set_sessionmaker(sessionmaker_)
    return create_app(settings, sessionmaker_, run_startup=False, core=_stub_core())


def _scoped_client(app, user_id, sessionmaker_):
    """Return an AsyncClient with current_user overridden to *user_id*.

    Re-fetches the user with roles+permissions eager-loaded inside a fresh
    session because require_permission -> effective_permissions walks
    user.roles/role.permissions (lazy="selectin"); a detached user would trip
    MissingGreenlet on that lazy load.
    """
    async def _cu():
        async with sessionmaker_() as s:
            return (
                await s.execute(
                    sqlalchemy.select(User)
                    .where(User.id == user_id)
                    .options(
                        selectinload(User.roles).selectinload(Role.permissions)
                    )
                )
            ).scalar_one()

    app.dependency_overrides[current_user] = _cu
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(
        transport=transport, base_url="http://test",
        headers={"X-Requested-With": "prd-app"},
    )


# ---- tests ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_postgres_ok(settings, sessionmaker_, db):
    """SELECT 1 returns fast → status=ok, latency_ms is a non-negative number,
    alembic head matches the most recent migration (d55aee795405), and
    tables_count is at least 1."""
    # The shared engine fixture only creates ORM tables; it does NOT create
    # `alembic_version`. The /_health/postgres route reads that table, so
    # stamp it here with the current head revision.
    from sqlalchemy import text
    await db.execute(text(
        "CREATE TABLE IF NOT EXISTS alembic_version ("
        "  version_num VARCHAR(32) NOT NULL"
        ")"
    ))
    await db.execute(text(
        "INSERT INTO alembic_version (version_num) VALUES ('d55aee795405') "
        "ON CONFLICT DO NOTHING"
    ))
    await db.commit()

    user = await _make_user(db, "pgadmin@ringkas.co.id", {"users.manage"})
    await db.commit()

    app = _build_app(settings, sessionmaker_)
    async with _scoped_client(app, user.id, sessionmaker_) as client:
        resp = await client.get("/api/prd/_health/postgres")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["latency_ms"], (int, float))
    assert body["latency_ms"] >= 0
    # Alembic head is the most recent migration: d55aee795405 (recent_views)
    assert body["alembic_revision"] == "d55aee795405"
    assert isinstance(body["tables_count"], int)
    assert body["tables_count"] >= 1
    assert "checked_at" in body


@pytest.mark.asyncio
async def test_postgres_slow(settings, sessionmaker_, db, monkeypatch):
    """When the measured elapsed time is 500ms, latency_ms must be > 100.

    We patch time.monotonic on prd_mcp.web.prd so the route's start/end pair
    reports a 500ms delta — without sleeping the test runner.
    """
    from sqlalchemy import text
    await db.execute(text(
        "CREATE TABLE IF NOT EXISTS alembic_version ("
        "  version_num VARCHAR(32) NOT NULL"
        ")"
    ))
    await db.execute(text(
        "INSERT INTO alembic_version (version_num) VALUES ('d55aee795405') "
        "ON CONFLICT DO NOTHING"
    ))
    await db.commit()

    user = await _make_user(db, "pgslow@ringkas.co.id", {"users.manage"})
    await db.commit()

    import prd_mcp.web.prd as prd_mod
    # The route calls time.monotonic() twice: once for `started`, once for
    # the latency calc. Middleware may call it zero or more times in
    # between. To guarantee a 500ms delta on the route's pair regardless
    # of what precedes/follows, alternate 0.0 / 0.5 starting from 0.0.
    state = {"n": 0}

    def fake_monotonic():
        state["n"] += 1
        return 0.0 if state["n"] % 2 == 1 else 0.5

    monkeypatch.setattr(prd_mod.time, "monotonic", fake_monotonic)

    app = _build_app(settings, sessionmaker_)
    async with _scoped_client(app, user.id, sessionmaker_) as client:
        resp = await client.get("/api/prd/_health/postgres")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["latency_ms"] > 100, f"expected >100ms, got {body['latency_ms']}"


@pytest.mark.asyncio
async def test_postgres_error(settings, sessionmaker_, db, monkeypatch):
    """If the DB dependency raises, the endpoint must return status=error with
    a message — never a 5xx (UI shows a banner, not a stacktrace)."""
    user = await _make_user(db, "pgerr@ringkas.co.id", {"users.manage"})
    await db.commit()

    import prd_mcp.web.prd as prd_mod
    from sqlalchemy.exc import DBAPIError

    class _BoomSession:
        async def execute(self, *args, **kwargs):
            raise DBAPIError("boom", params=None, orig=Exception("connection refused"))

        async def commit(self):
            pass

        async def rollback(self):
            pass

    async def _boom_dep():
        yield _BoomSession()

    # Use FastAPI's dependency_overrides (the official hook for this) instead
    # of monkeypatching prd_mod.get_db — Depends(get_db) captured the original
    # function at route-registration time, so a module-attr swap is a no-op.
    app = _build_app(settings, sessionmaker_)
    app.dependency_overrides[prd_mod.get_db] = _boom_dep

    async with _scoped_client(app, user.id, sessionmaker_) as client:
        resp = await client.get("/api/prd/_health/postgres")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "error"
    assert "message" in body and body["message"]
    lower = body["message"].lower()
    assert "boom" in lower or "connection refused" in lower


@pytest.mark.asyncio
async def test_postgres_requires_users_manage(settings, sessionmaker_, db):
    """A user without users.manage must get 403 — same gate as /_health/notion."""
    user = await _make_user(db, "noperm_pg@ringkas.co.id", {"prd.read"})
    await db.commit()

    app = _build_app(settings, sessionmaker_)
    async with _scoped_client(app, user.id, sessionmaker_) as client:
        resp = await client.get("/api/prd/_health/postgres")
    assert resp.status_code == 403, f"expected 403, got {resp.status_code}: {resp.text}"
