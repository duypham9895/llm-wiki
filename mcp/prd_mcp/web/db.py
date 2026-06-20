"""Async SQLAlchemy engine, sessionmaker, and the get_db() FastAPI dependency."""
from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def make_engine(database_url: str):
    return create_async_engine(database_url, pool_pre_ping=True, future=True)


def make_sessionmaker(engine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


# Set by create_app() at startup so the dependency can reach the live sessionmaker.
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def set_sessionmaker(sm: async_sessionmaker[AsyncSession]) -> None:
    global _sessionmaker
    _sessionmaker = sm


async def get_db() -> AsyncIterator[AsyncSession]:
    if _sessionmaker is None:  # pragma: no cover - misconfiguration guard
        raise RuntimeError("sessionmaker not initialized; call set_sessionmaker in create_app")
    async with _sessionmaker() as session:
        try:
            yield session
        except Exception:
            # Guarantee the "rolls back with 409/422" contract for any handler
            # that raised after a flush — never let a flushed-but-uncommitted
            # mutation leak. (async-with close also rolls back an open txn, but
            # this makes the rollback explicit and ordering-independent.)
            await session.rollback()
            raise
