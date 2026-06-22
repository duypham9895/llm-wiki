"""Alembic environment — sync engine, URL from ALEMBIC_DATABASE_URL or DATABASE_URL.

Migrations run with the SYNCHRONOUS psycopg3 driver; the app uses asyncpg at
runtime. We rewrite the URL's driver to `+psycopg` (psycopg3) so SQLAlchemy does
not default to psycopg2 (which is not a declared dependency).
"""
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from prd_mcp.web.db import Base
import prd_mcp.web.models  # noqa: F401  (register auth tables on Base.metadata)
import prd_mcp.web.chatmodels  # noqa: F401  (register chat tables on Base.metadata)

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _url() -> str:
    url = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
    # Force the sync psycopg3 driver regardless of how the URL was written.
    for drv in ("+asyncpg", "+psycopg2", "+psycopg"):
        url = url.replace(drv, "")
    return url.replace("postgresql://", "postgresql+psycopg://", 1)


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section) or {}
    section["sqlalchemy.url"] = _url()
    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
