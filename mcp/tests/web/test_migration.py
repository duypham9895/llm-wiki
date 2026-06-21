import os
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from prd_mcp.web.db import Base
import prd_mcp.web.models  # noqa: F401  (register tables on Base.metadata)

# mcp/ package root = three parents up from tests/web/test_migration.py
MCP_ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_migration_produces_same_tables_as_metadata(pg_url):
    """`alembic upgrade head` must build exactly the tables the ORM declares.

    env.py rewrites the +asyncpg URL to the sync +psycopg driver, so passing the
    asyncpg pg_url through ALEMBIC_DATABASE_URL is correct.
    """
    env = dict(os.environ, ALEMBIC_DATABASE_URL=pg_url)
    # fresh DB state: drop everything first via a throwaway engine
    eng = create_async_engine(pg_url)
    async with eng.begin() as conn:
        # asyncpg cannot execute multiple statements in one call; split them.
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await eng.dispose()

    # cwd = the mcp/ dir (where alembic.ini lives), resolved absolutely so this
    # works regardless of where pytest was launched from.
    r = subprocess.run(
        ["poetry", "run", "alembic", "upgrade", "head"],
        cwd=str(MCP_ROOT), env=env, capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr

    eng = create_async_engine(pg_url)
    async with eng.connect() as conn:
        rows = await conn.execute(text(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
        ))
        tables = {row[0] for row in rows}
    await eng.dispose()
    expected = set(Base.metadata.tables.keys())
    assert expected.issubset(tables), f"missing {expected - tables}"


@pytest.mark.asyncio
async def test_downgrade_then_upgrade_roundtrips(pg_url):
    """alembic downgrade base then upgrade head must both succeed and leave tables intact."""
    env = dict(os.environ, ALEMBIC_DATABASE_URL=pg_url)

    # Start from a fresh schema
    eng = create_async_engine(pg_url)
    async with eng.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await eng.dispose()

    # upgrade head
    r = subprocess.run(
        ["poetry", "run", "alembic", "upgrade", "head"],
        cwd=str(MCP_ROOT), env=env, capture_output=True, text=True,
    )
    assert r.returncode == 0, f"upgrade head failed:\n{r.stderr}"

    # downgrade base
    r = subprocess.run(
        ["poetry", "run", "alembic", "downgrade", "base"],
        cwd=str(MCP_ROOT), env=env, capture_output=True, text=True,
    )
    assert r.returncode == 0, f"downgrade base failed:\n{r.stderr}"

    # upgrade head again
    r = subprocess.run(
        ["poetry", "run", "alembic", "upgrade", "head"],
        cwd=str(MCP_ROOT), env=env, capture_output=True, text=True,
    )
    assert r.returncode == 0, f"second upgrade head failed:\n{r.stderr}"

    # final state must have all ORM tables
    eng = create_async_engine(pg_url)
    async with eng.connect() as conn:
        rows = await conn.execute(text(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
        ))
        tables = {row[0] for row in rows}
    await eng.dispose()
    expected = set(Base.metadata.tables.keys())
    assert expected.issubset(tables), f"missing after roundtrip: {expected - tables}"
