"""Test-only ASGI app for the out-of-process concurrency proof.

This module is imported by a uvicorn subprocess launched from
test_chat_concurrency.py.  It MUST NOT be imported in the normal test run.

How it works
------------
1. Reads DATABASE_URL and other settings from env (set by the parent test).
2. Builds the real create_app(...) with a *fake blocking core* whose
   llm.chat sleeps for BLOCK_SECONDS.  Because chat.py offloads rewrite_query
   via anyio.to_thread.run_sync, that sleep runs in a worker thread — the
   uvicorn event loop stays free.  A concurrent /healthz then returns promptly
   over the real socket.  If offload were removed, the sleep would freeze the
   loop and /healthz would time out.
3. Auth is short-circuited: current_user is dependency-overridden to re-fetch a
   seeded user by USER_ID (read from env), exactly as conftest's _perm_client
   does.  The REAL require_permission guard still runs.
4. Schema + seed are created by the PARENT test before launching this subprocess
   (via async create_all + run_seed), so no migration is needed here.

Environment variables (set by parent test):
  DATABASE_URL            — asyncpg URL of the testcontainer Postgres instance
  CONCURRENCY_USER_ID     — UUID string of the seeded user with prd.ask perm
  CONCURRENCY_BLOCK_SECONDS — how long llm.chat sleeps (default: 30)
  CORS_ORIGIN, ADMIN_EMAIL, ADMIN_PASSWORD, ENV — required by WebSettings
"""
from __future__ import annotations

import os
import time
import uuid

import sqlalchemy
from sqlalchemy.orm import selectinload

import prd_mcp.web.chat as _chatmod  # noqa: E402 – must import before patching

from prd_mcp.web.app import create_app
from prd_mcp.web import db as db_mod
from prd_mcp.web.coredeps import Core
from prd_mcp.web.db import make_engine, make_sessionmaker
from prd_mcp.web.models import User, Role
from prd_mcp.web.rbac import current_user
from prd_mcp.web.settings import load_settings

# ── env vars injected by the parent test ──────────────────────────────────────
_DATABASE_URL: str = os.environ["DATABASE_URL"]
_USER_ID: str = os.environ["CONCURRENCY_USER_ID"]
BLOCK_SECONDS: float = float(os.environ.get("CONCURRENCY_BLOCK_SECONDS", "30"))
# Marker file written the instant llm.chat ENTERS its block. The parent waits for
# this file before probing /healthz, so the probe is synchronized with the block
# actually being in flight — not a fragile fixed sleep that could false-pass if the
# POST is slow to arrive or fails before reaching rewrite_query (Codex review).
_MARKER_FILE: str | None = os.environ.get("CONCURRENCY_MARKER_FILE")

# ── DB ────────────────────────────────────────────────────────────────────────
_engine = make_engine(_DATABASE_URL)
_sm = make_sessionmaker(_engine)


# ── fake blocking core ────────────────────────────────────────────────────────

class _FakeR:
    doc_stem = "EP-1"
    doc_id = "EP-1"
    title = "T"
    source_url = ""
    summary = "s"
    tags: list = []
    status = ""
    text = "ctx"
    score = 0.5


class _BlockingLlm:
    def embed(self, texts):
        return [[0.1, 0.2]]

    def chat(self, messages):
        """Blocks the calling thread for BLOCK_SECONDS.

        chat.py calls this via anyio.to_thread.run_sync so the block
        lands in a worker thread.  A regression that calls it on the
        event loop directly would freeze uvicorn's single worker and
        make /healthz unreachable over the socket.

        Writes the marker file the instant the block is entered, so the
        parent test probes /healthz only once the block is provably in
        flight (Codex review — replaces a fragile fixed sleep).
        """
        if _MARKER_FILE:
            try:
                with open(_MARKER_FILE, "w") as fh:
                    fh.write("entered")
            except OSError:
                pass  # best-effort; parent has a bounded wait either way
        time.sleep(BLOCK_SECONDS)
        return "fake answer"

    async def chat_stream(self, messages, **kw):
        for tok in ["a", "b"]:
            yield tok


class _FakeStore:
    def stored_hashes(self):
        return {"EP-1": "h"}

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


class _FakeCfg:
    prds_dir = "/tmp/prds"
    score_threshold = -0.15
    top_k = 8
    vault_path = "/tmp/vault"
    chroma_path = "/tmp/chroma"


_fake_core = Core(cfg=_FakeCfg(), store=_FakeStore(), llm=_BlockingLlm())

# ── make retrieve fast so ONLY llm.chat (via rewrite_query) blocks ───────────
# chat.py imports `retrieve` at module level from prd_mcp.retrieve; we patch
# the name in chat's namespace after importing the module above.

def _fast_retrieve(q, store, embed, k, th):
    return ([_FakeR()], "match")


_chatmod.retrieve = _fast_retrieve  # type: ignore[attr-defined]

# ── build app ─────────────────────────────────────────────────────────────────
settings = load_settings()  # reads os.environ (DATABASE_URL etc. are already set)
db_mod.set_sessionmaker(_sm)
app = create_app(settings, _sm, run_startup=False, core=_fake_core)


# ── auth override: re-fetch seeded user by known UUID ────────────────────────
_fixed_user_uuid = uuid.UUID(_USER_ID)


async def _fixed_current_user():
    async with _sm() as s:
        return (
            await s.execute(
                sqlalchemy.select(User)
                .where(User.id == _fixed_user_uuid)
                .options(
                    selectinload(User.roles).selectinload(Role.permissions)
                )
            )
        ).scalar_one()


app.dependency_overrides[current_user] = _fixed_current_user
