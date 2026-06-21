"""Real-Postgres test fixtures via testcontainers. The RBAC/session/invariant
logic is the whole point of this phase; SQLite/fakes would hide citext, text[],
FK cascades, and transactional rollback — the security-critical behaviors."""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from testcontainers.postgres import PostgresContainer

from prd_mcp.web.db import Base, make_engine, make_sessionmaker
from prd_mcp.web.settings import load_settings
import prd_mcp.web.models  # noqa: F401  (register tables on Base.metadata)
import prd_mcp.web.chatmodels  # noqa: F401  (register chat tables for create_all)

TEST_ARGON = {"ARGON2_TIME_COST": "1", "ARGON2_MEMORY_KIB": "8", "ARGON2_PARALLELISM": "1"}


@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture(scope="session")
def pg_url(pg_container) -> str:
    # testcontainers returns a psycopg2 URL; convert to asyncpg driver.
    raw = pg_container.get_connection_url()  # postgresql+psycopg2://...
    return raw.replace("postgresql+psycopg2://", "postgresql+asyncpg://")


@pytest.fixture(scope="session")
def base_env(pg_url) -> dict:
    return {
        "DATABASE_URL": pg_url,
        "CORS_ORIGIN": "https://prd.test",
        "ADMIN_EMAIL": "admin@ringkas.co.id",
        "ADMIN_PASSWORD": "break glass admin pw 123",
        "ENV": "dev",
        **TEST_ARGON,
    }


@pytest.fixture
def settings(base_env):
    return load_settings(base_env)


@pytest_asyncio.fixture
async def engine(pg_url):
    eng = make_engine(pg_url)
    async with eng.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def sessionmaker_(engine):
    return make_sessionmaker(engine)


@pytest_asyncio.fixture
async def db(sessionmaker_):
    async with sessionmaker_() as session:
        yield session


import httpx
import pytest_asyncio
from prd_mcp.web.app import create_app
from prd_mcp.web import db as db_mod, seed as seed_mod


@pytest_asyncio.fixture
async def app(settings, sessionmaker_):
    db_mod.set_sessionmaker(sessionmaker_)
    application = create_app(settings, sessionmaker_, run_startup=False)
    async with sessionmaker_() as s:
        await seed_mod.run_seed(s, settings)
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", headers={"X-Requested-With": "prd-app"}
    ) as c:
        yield c


# ---------------------------------------------------------------------------
# Phase 3 web fixtures — permission-scoped clients, fake core, chat fixtures
# ---------------------------------------------------------------------------
import sqlalchemy
from prd_mcp.web.coredeps import Core
from prd_mcp.web.rbac import current_user
from prd_mcp.web.models import User, Role, Permission
from prd_mcp.web.chatmodels import Conversation  # noqa: F401 (also registers table)


async def make_user_with_perms(db, email: str, perms: set, status: str = "active") -> User:
    """Create a user holding exactly *perms* via a dedicated role.

    Reuses existing Permission rows (query first) to avoid unique-name violations
    when multiple fixtures create the same permission name in the same test.
    Mirrors the pattern from tests/web/test_invariants.py.
    """
    user = User(email=email, password_hash="x", status=status)
    if perms:
        role = Role(name=f"role_{email.split('@')[0]}")
        for name in sorted(perms):
            existing = (
                await db.execute(
                    sqlalchemy.select(Permission).where(Permission.name == name)
                )
            ).scalar_one_or_none()
            role.permissions.append(existing if existing is not None else Permission(name=name))
        user.roles.append(role)
        db.add(role)
    db.add(user)
    await db.flush()
    return user


def _fake_core() -> Core:
    class FakeStore:
        def stored_hashes(self):
            return {"EP-1": "h", "EP-2": ""}

        def list_cards(self, status=None, tag=None, cursor=None, limit=50):
            return {
                "results": [
                    {
                        "id": "EP-1",
                        "title": "T",
                        "status": "active",
                        "tags": [],
                        "summary": "s",
                        "source_url": "",
                    }
                ],
                "next_cursor": None,
            }

    class FakeLlm:
        def embed(self, texts):
            return [[0.1, 0.2]]

        def chat(self, messages):
            return "rewritten"

        async def chat_stream(self, messages, **kw):
            for token in ["a", "b"]:
                yield token

    class FakeCfg:
        prds_dir = "/tmp/prds"
        score_threshold = -0.15
        top_k = 8
        vault_path = "/tmp/vault"
        chroma_path = "/tmp/chroma"

    return Core(cfg=FakeCfg(), store=FakeStore(), llm=FakeLlm())


@pytest_asyncio.fixture
def fake_core() -> Core:
    return _fake_core()


@pytest_asyncio.fixture
async def app_with_core(settings, sessionmaker_, fake_core):
    """Like the `app` fixture but with the PRD core mounted on app.state."""
    db_mod.set_sessionmaker(sessionmaker_)
    application = create_app(settings, sessionmaker_, run_startup=False, core=fake_core)
    async with sessionmaker_() as s:
        await seed_mod.run_seed(s, settings)
    return application


def _perm_client(app, user: User) -> httpx.AsyncClient:
    """Return an AsyncClient whose current_user is overridden to *user*.

    Overrides current_user (not require_permission) so the REAL
    require_permission guard runs — a client_no_perms user genuinely receives 403.
    """

    async def _cu():
        return user

    app.dependency_overrides[current_user] = _cu
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-Requested-With": "prd-app"},
    )


@pytest_asyncio.fixture
async def client_prd_read(app_with_core, db):
    user = await make_user_with_perms(db, "reader@ringkas.co.id", {"prd.read"})
    await db.commit()
    async with _perm_client(app_with_core, user) as c:
        yield c


@pytest_asyncio.fixture
async def ask_user(db) -> User:
    user = await make_user_with_perms(db, "asker@ringkas.co.id", {"prd.read", "prd.ask"})
    await db.commit()
    return user


@pytest_asyncio.fixture
async def client_prd_ask(app_with_core, ask_user):
    async with _perm_client(app_with_core, ask_user) as c:
        yield c


@pytest_asyncio.fixture
async def client_status_view(app_with_core, db):
    user = await make_user_with_perms(db, "ops@ringkas.co.id", {"status.view"})
    await db.commit()
    async with _perm_client(app_with_core, user) as c:
        yield c


@pytest_asyncio.fixture
async def client_no_perms(app_with_core, db):
    user = await make_user_with_perms(db, "noperm@ringkas.co.id", set())
    await db.commit()
    async with _perm_client(app_with_core, user) as c:
        yield c


@pytest_asyncio.fixture
async def conv_id(db, ask_user) -> str:
    """A conversation owned by ask_user (the same user behind client_prd_ask)."""
    conv = Conversation(user_id=ask_user.id, title="")
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return str(conv.id)


@pytest_asyncio.fixture
async def busy_conv_id(db, ask_user) -> str:
    """A conversation owned by ask_user with generating=True."""
    conv = Conversation(user_id=ask_user.id, title="", generating=True)
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return str(conv.id)


@pytest_asyncio.fixture
async def other_users_conversation_id(db) -> str:
    """A conversation owned by a different user (not ask_user)."""
    other = await make_user_with_perms(db, "other@ringkas.co.id", {"prd.ask"})
    await db.commit()
    conv = Conversation(user_id=other.id, title="")
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return str(conv.id)
