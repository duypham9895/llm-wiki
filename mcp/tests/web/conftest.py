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
