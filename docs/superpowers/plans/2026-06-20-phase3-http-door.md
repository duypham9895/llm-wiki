# Phase 3 — Python HTTP Door (PRD / Chat / Status APIs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the HTTP/JSON door that serves the dashboard — Library/Search/Ask/Status — by mounting PRD, Chat (SSE streaming), and Status routers into Phase 2's existing FastAPI app, over the **same** shared PRD core (one brain, two doors). Adds streaming + multi-turn chat to the core (the first time Phase 3 touches it).

**Architecture:** The shared core (`mcp/prd_mcp/`) gains `rewrite_query`, `answer_stream`, and an async `chat_stream`. Three new routers in `mcp/prd_mcp/web/` (prd, chat, status) call the core's existing `_impl` functions and the new streaming ones, each behind Phase 2's `require_permission(...)`. Chat history lives in two new tables in the same `prd_auth` Postgres. The Status router reads the run-manifests Plan B writes.

**Tech Stack:** Python 3 (FastAPI, async SQLAlchemy, pydantic-settings, argon2 — all already in Phase 2), `httpx` (already used), `anyio` (ships with Starlette), `sse-starlette` (new dep) for SSE. pytest + async httpx test client + disposable Postgres (Phase 2's conftest). No live LLM/embed/Chroma in tests.

## Global Constraints

- **Depends on Phase 2 landing** (tasks 5–11 of the auth build) — this plan executes after. It consumes, verbatim: `require_permission(name)` and `current_user` (`prd_mcp/web/rbac.py`), `get_db` (`prd_mcp/web/db.py`), `create_app(settings, sessionmaker, *, run_startup=True)` and the `{error:{code,message}}` envelope + `CSRFMiddleware` (`prd_mcp/web/app.py`), `WebSettings` (`prd_mcp/web/settings.py`), the `Base` declarative class (`prd_mcp/web/db.py`), `User` model (`prd_mcp/web/models.py`).
- **Depends on Plan B** for the Status API: imports `read_latest_run(vault_path)` and `read_run_history(vault_path, limit)` from `prd_mcp.web.manifests` (locked interface, Codex-SHIP).
- **Permissions (exact, from `rbac.py` PERMISSIONS):** `prd.read` (Library+Search), `prd.ask` (Ask), `status.view` (Status). Every router endpoint declares its `require_permission`.
- **CSRF:** every state-changing request (incl. the chat POST) must carry `X-Requested-With: prd-app` (Phase 2's `CSRFMiddleware` enforces 403 otherwise). The SSE endpoint is POST → subject to CSRF.
- **Single uvicorn worker** (Phase 2's rate limiter requires it). Therefore: `chat_stream` is **async**; every **sync** core call the chat route makes (`rewrite_query`→sync `chat`, `embed`, `retrieve`) is offloaded via `anyio.to_thread.run_sync`. No DB transaction is held open across a stream.
- **Core reuse:** the HTTP door calls the SAME functions as `server.py` (`search_prds_impl`, `keyword_search_impl`, `read_prd_impl`, and the existing `retrieve`/`answer`); it does NOT reimplement retrieval/answering.
- **No secrets in responses/logs**; LLM keys read only by the core's `LlmClient`.
- **TDD, frequent commits.** Tests use fakes (fake `chat_fn`/`chat_stream_fn`/`embed_fn`, fake store) + real Postgres for chat ownership/cascade.

---

## File Structure

**Core (extended, still MCP/web-agnostic):**
- `mcp/prd_mcp/answer.py` — MODIFY. Add `rewrite_query(history, latest, chat_fn) -> str` and `async answer_stream(question, retrieved, verdict, chat_stream_fn) -> AsyncIterator[str]`. Keep `answer()`, `build_messages()`, `format_sources()` unchanged.
- `mcp/prd_mcp/llm.py` — MODIFY. Add `async def chat_stream(self, messages) -> AsyncIterator[str]` to `LlmClient` (httpx.AsyncClient streaming). Keep sync `chat`/`embed`.

**Web door:**
- `mcp/prd_mcp/web/prd.py` — NEW. Router: library/search/read. Calls `search_prds_impl`/`keyword_search_impl`/`read_prd_impl`.
- `mcp/prd_mcp/web/chatmodels.py` — NEW. `Conversation`, `Message` ORM (Phase 2's `Base`).
- `mcp/prd_mcp/web/chat.py` — NEW. Router: conversations CRUD + SSE message stream.
- `mcp/prd_mcp/web/status.py` — NEW. Router: pipeline/coverage/history over `manifests.py`.
- `mcp/prd_mcp/web/coredeps.py` — NEW. Builds + holds the PRD core (`cfg`, `store`, `llm`) on `app.state`, plus FastAPI deps to reach it. This is how the HTTP door gets the core that `cli.py` builds for `index`/`serve`.
- `mcp/prd_mcp/web/app.py` — MODIFY. `create_app(...)` gains an optional `core` param; mounts prd/chat/status routers when a core is provided.
- `mcp/prd_mcp/cli.py` — MODIFY. The `web` subcommand builds the PRD core (cfg/store/llm) and passes it to `create_app`.
- `migrations/versions/xxxx_chat_tables.py` — NEW. Alembic migration for `conversations`/`messages`.
- `mcp/pyproject.toml` — MODIFY. Add `sse-starlette`.

**Tests:** `mcp/tests/test_answer_stream.py`, `mcp/tests/web/test_prd_api.py`, `mcp/tests/web/test_chat_api.py`, `mcp/tests/web/test_status_api.py` (+ a fake-core fixture in `mcp/tests/web/conftest.py`).

---

### Task 1: Core — `rewrite_query` (standalone-query rewriting)

**Files:**
- Modify: `mcp/prd_mcp/answer.py`
- Test: `mcp/tests/test_answer_stream.py`

**Interfaces:**
- Consumes: a `chat_fn(messages: list[dict]) -> str` (the same shape `LlmClient.chat` provides).
- Produces: `def rewrite_query(history: list[dict], latest: str, chat_fn) -> str` — `history` is a list of `{"role","content"}` turns (oldest→newest, EXCLUDING `latest`). Returns a standalone search query. If `history` is empty, returns `latest` unchanged WITHOUT calling `chat_fn`.

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/test_answer_stream.py
from prd_mcp.answer import rewrite_query


def test_rewrite_query_empty_history_returns_latest_no_llm():
    calls = []
    def chat_fn(messages):
        calls.append(messages)
        return "SHOULD NOT BE CALLED"
    assert rewrite_query([], "what is SP3K?", chat_fn) == "what is SP3K?"
    assert calls == []  # no LLM call when there's no prior context


def test_rewrite_query_uses_history_to_make_standalone():
    history = [
        {"role": "user", "content": "tell me about referral PRDs"},
        {"role": "assistant", "content": "EP-457 covers referrals..."},
    ]
    captured = {}
    def chat_fn(messages):
        captured["messages"] = messages
        return "referral bank report dashboard PRD"
    out = rewrite_query(history, "what about the bank report one?", chat_fn)
    assert out == "referral bank report dashboard PRD"
    # the prompt must include both the history and the latest follow-up
    blob = " ".join(m["content"] for m in captured["messages"])
    assert "bank report" in blob and "referral" in blob


def test_rewrite_query_blank_latest_returns_blank_no_llm():
    calls = []
    assert rewrite_query([{"role": "user", "content": "x"}], "   ", lambda m: calls.append(m) or "y") == "   "
    assert calls == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/test_answer_stream.py::test_rewrite_query_empty_history_returns_latest_no_llm -v`
Expected: FAIL — `rewrite_query` not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `mcp/prd_mcp/answer.py`:

```python
REWRITE_SYSTEM = (
    "Rewrite the user's latest message into a single standalone search query for a PRD "
    "knowledge base, using the conversation for context (resolve pronouns/references like "
    "'that one'). Output ONLY the query text, no quotes, no explanation."
)


def rewrite_query(history: list, latest: str, chat_fn) -> str:
    # No prior turns OR a blank message -> nothing to rewrite; skip the LLM entirely.
    if not history or not latest or not latest.strip():
        return latest
    convo = "\n".join(f"{m['role']}: {m['content']}" for m in history)
    messages = [
        {"role": "system", "content": REWRITE_SYSTEM},
        {"role": "user", "content": f"Conversation so far:\n{convo}\n\nLatest message: {latest}\n\nStandalone query:"},
    ]
    return chat_fn(messages).strip()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/test_answer_stream.py -v -k rewrite_query`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/answer.py mcp/tests/test_answer_stream.py
git commit -m "feat(core): rewrite_query for standalone follow-up queries (no LLM on empty history)"
```

---

### Task 2: Core — async `chat_stream` + `answer_stream`

**Files:**
- Modify: `mcp/prd_mcp/llm.py` (add `chat_stream`)
- Modify: `mcp/prd_mcp/answer.py` (add `answer_stream`)
- Test: `mcp/tests/test_answer_stream.py` (extend)

**Interfaces:**
- Produces in `answer.py`: `async def answer_stream(question: str, retrieved: list, verdict: str, chat_stream_fn) -> AsyncIterator[str]` — async generator. On `verdict == "no_match"` or empty `retrieved`, yields the single fixed non-answer string `"No PRD covers this."` and does NOT call `chat_stream_fn`. Otherwise `async for tok in chat_stream_fn(build_messages(question, retrieved)): yield tok`.
- Produces in `llm.py`: `async def chat_stream(self, messages) -> AsyncIterator[str]` on `LlmClient` — yields content-delta tokens from the provider's `stream:true` SSE. (Used in production; tests pass a fake async generator, so this method itself is covered by a light unit test with a fake async transport.)

**Note:** `answer_stream` is token-only (Codex spec-review #11): sources/grounded are built by the chat route from `retrieved`+`verdict` via the existing `format_sources()`, NOT yielded here.

- [ ] **Step 1: Write the failing test**

```python
# add to mcp/tests/test_answer_stream.py
import pytest
from prd_mcp.answer import answer_stream
from prd_mcp.retrieve import Retrieved


def _mk(stem="EP-1"):
    return Retrieved(doc_stem=stem, doc_id=stem, title="T", summary="s", tags=[], status="", source_url="", text="ctx", score=0.5)


async def _collect(agen):
    return [tok async for tok in agen]


@pytest.mark.asyncio
async def test_answer_stream_no_match_yields_fixed_nonanswer_no_llm():
    called = False
    async def chat_stream_fn(messages):
        nonlocal called
        called = True
        yield "X"
    toks = await _collect(answer_stream("q", [], "no_match", chat_stream_fn))
    assert "".join(toks) == "No PRD covers this."
    assert called is False


@pytest.mark.asyncio
async def test_answer_stream_match_streams_tokens_from_fn():
    async def chat_stream_fn(messages):
        for t in ["He", "llo"]:
            yield t
    toks = await _collect(answer_stream("q", [_mk()], "match", chat_stream_fn))
    assert "".join(toks) == "Hello"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/test_answer_stream.py -v -k answer_stream`
Expected: FAIL — `answer_stream` not defined. (Ensure `pytest-asyncio` is configured; Phase 2 already uses async tests — if `asyncio_mode` isn't `auto`, the `@pytest.mark.asyncio` marker covers it.)

- [ ] **Step 3: Write minimal implementation**

Add to `mcp/prd_mcp/answer.py` (reusing the existing `build_messages`):

```python
NON_ANSWER = "No PRD covers this."


async def answer_stream(question: str, retrieved: list, verdict: str, chat_stream_fn):
    if verdict == "no_match" or not retrieved:
        yield NON_ANSWER
        return
    async for tok in chat_stream_fn(build_messages(question, retrieved)):
        yield tok
```

Add to `mcp/prd_mcp/llm.py` (`LlmClient`), using an injectable async streamer so it's testable; the default uses `httpx.AsyncClient`:

```python
# at top of llm.py
import json
import httpx

# inside class LlmClient:
    async def chat_stream(self, messages):
        url = f"{self.cfg.minimax_base}/chat/completions"
        headers = {"content-type": "application/json",
                   "authorization": f"Bearer {self.cfg.minimax_key}"}
        body = {"model": self.cfg.chat_model, "messages": messages,
                "temperature": 0.2, "stream": True}
        timeout = getattr(self.cfg, "request_timeout", 60)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = json.loads(data)["choices"][0]["delta"].get("content")
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    if delta:
                        yield delta
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/test_answer_stream.py -v`
Expected: PASS (all rewrite + answer_stream tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/answer.py mcp/prd_mcp/llm.py mcp/tests/test_answer_stream.py
git commit -m "feat(core): async answer_stream (token-only, no-match short-circuit) + LlmClient.chat_stream"
```

---

### Task 3: Core access for the web door (`coredeps.py`)

**Files:**
- Create: `mcp/prd_mcp/web/coredeps.py`
- Test: `mcp/tests/web/test_coredeps.py`

**Interfaces:**
- Produces:
  - `class Core: cfg; store; llm` (a tiny container).
  - `def set_core(app, core: Core) -> None` — stash on `app.state.core`.
  - `def get_core(request) -> Core` — FastAPI dependency returning `request.app.state.core` (raises a clear `RuntimeError` if unset).

**Why:** Phase 2's `create_app` only knows the DB. The PRD core (`cfg`/`store`/`llm`) is built in `cli.py` (verified in `cli.py:40-45,51`). This module lets the `web` command build the core once and hand it to the app, and lets routers reach it via a dependency (so tests inject a fake core).

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/web/test_coredeps.py
import pytest
from types import SimpleNamespace
from prd_mcp.web.coredeps import Core, set_core, get_core


def test_set_and_get_core():
    app = SimpleNamespace(state=SimpleNamespace())
    core = Core(cfg="C", store="S", llm="L")
    set_core(app, core)
    request = SimpleNamespace(app=app)
    got = get_core(request)
    assert (got.cfg, got.store, got.llm) == ("C", "S", "L")


def test_get_core_unset_raises():
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    with pytest.raises(RuntimeError, match="core not initialized"):
        get_core(request)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/web/test_coredeps.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/prd_mcp/web/coredeps.py
"""Holds the shared PRD core (cfg/store/llm) on app.state so the HTTP door's
routers can reach the SAME core that cli.py builds for index/serve."""
from __future__ import annotations

from dataclasses import dataclass
from fastapi import Request


@dataclass
class Core:
    cfg: object
    store: object
    llm: object


def set_core(app, core: Core) -> None:
    app.state.core = core


def get_core(request: Request) -> Core:
    core = getattr(request.app.state, "core", None)
    if core is None:
        raise RuntimeError("core not initialized; pass core= to create_app for the web door")
    return core
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/web/test_coredeps.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/web/coredeps.py mcp/tests/web/test_coredeps.py
git commit -m "feat(web): Core container + app.state accessor for the HTTP door"
```

---

### Task 4: PRD read router (`prd.py`)

**Files:**
- Create: `mcp/prd_mcp/web/prd.py`
- Test: `mcp/tests/web/test_prd_api.py`
- Modify: `mcp/prd_mcp/web/app.py` (mount the router when a core is present — also done in Task 8; here we add the minimal wiring needed to test)

**Interfaces:**
- Consumes: `get_core` (Task 3); `require_permission("prd.read")` (Phase 2); `search_prds_impl`, `keyword_search_impl`, `read_prd_impl` from `prd_mcp.server` (verified signatures: `search_prds_impl(cfg, store, llm, query, k)`, `keyword_search_impl(cfg, store, llm, query, k)`, `read_prd_impl(cfg, prd_id)`).
- Produces: `router = APIRouter(prefix="/api/prd")` with `GET /search`, `GET /{id}`, `GET /library`.

**Note:** `search_prds_impl`/`keyword_search_impl`/`read_prd_impl` are SYNC and touch Chroma; offload them with `anyio.to_thread.run_sync` so the single worker isn't blocked. Library reuses keyword/search infra: for v1, `GET /library` returns a simple listing via `read_prd_impl`-style vault listing is overkill — instead library lists from the store's metadata. To stay within the locked core, **library is implemented as an empty-query-guarded listing built from `store`**; expose a `list_library(cfg, store, status, tag, cursor, limit)` helper in `prd.py` that pages over `store` metadata. (If the store lacks a list primitive, the helper falls back to `read_prd_impl` over `list_docs`; the test uses a fake core exposing a `list_library`-compatible store.)

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/web/test_prd_api.py
import pytest
from prd_mcp.web.coredeps import Core


@pytest.fixture
def fake_core():
    # minimal fakes; the router calls server._impl funcs which take (cfg, store, llm, ...)
    class FakeStore:
        def stored_hashes(self): return {"EP-1": "h"}
    class FakeLlm:
        def embed(self, texts): return [[0.1, 0.2]]
    class FakeCfg:
        prds_dir = "/tmp/prds"; score_threshold = -0.15; top_k = 8
    return Core(cfg=FakeCfg(), store=FakeStore(), llm=FakeLlm())


@pytest.mark.asyncio
async def test_search_requires_prd_read(client_no_perms):
    r = await client_no_perms.get("/api/prd/search?q=referral")
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_search_returns_verdict_shape(client_prd_read, monkeypatch):
    import prd_mcp.web.prd as prdmod
    monkeypatch.setattr(prdmod, "search_prds_impl",
                        lambda cfg, store, llm, q, k: {"count": 1, "verdict": "match",
                                                       "results": [{"id": "EP-1", "title": "T", "score": 0.4}]})
    r = await client_prd_read.get("/api/prd/search?q=referral")
    assert r.status_code == 200
    body = r.json()
    assert body["verdict"] == "match" and body["count"] == 1


@pytest.mark.asyncio
async def test_read_unknown_id_404(client_prd_read, monkeypatch):
    import prd_mcp.web.prd as prdmod
    monkeypatch.setattr(prdmod, "read_prd_impl",
                        lambda cfg, prd_id: {"found": False, "id": prd_id, "body": ""})
    r = await client_prd_read.get("/api/prd/EP-999")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
```

(`client_prd_read` / `client_no_perms` are fixtures added in Task 7's conftest — a test client whose `current_user`/`require_permission` is overridden to a user holding `prd.read` / no perms, with the fake core set on the app. This task's test will be RED until Task 7's fixtures exist; run it after Task 7, OR stub the fixtures locally first. To keep tasks independently runnable, add the fixtures in this task's conftest if not present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/web/test_prd_api.py -v`
Expected: FAIL — `prd_mcp.web.prd` not found.

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/prd_mcp/web/prd.py
"""HTTP door for PRD read: Library, Search, Read. Wraps the SAME core _impl
functions the MCP server uses; offloads the sync/Chroma calls off the event loop."""
from __future__ import annotations

import anyio
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.web.rbac import require_permission
from prd_mcp.server import search_prds_impl, keyword_search_impl, read_prd_impl

router = APIRouter(prefix="/api/prd")


@router.get("/search")
async def search(q: str = Query(""), mode: str = Query("semantic"), k: int = Query(8),
                 core: Core = Depends(get_core), _=Depends(require_permission("prd.read"))):
    if mode == "keyword":
        return await anyio.to_thread.run_sync(keyword_search_impl, core.cfg, core.store, core.llm, q, k)
    return await anyio.to_thread.run_sync(search_prds_impl, core.cfg, core.store, core.llm, q, k)


@router.get("/library")
async def library(status: str = Query(None), tag: str = Query(None),
                  cursor: str = Query(None), limit: int = Query(50),
                  core: Core = Depends(get_core), _=Depends(require_permission("prd.read"))):
    return await anyio.to_thread.run_sync(list_library, core.cfg, core.store, status, tag, cursor, limit)


@router.get("/{prd_id}")
async def read_one(prd_id: str, core: Core = Depends(get_core),
                   _=Depends(require_permission("prd.read"))):
    res = await anyio.to_thread.run_sync(read_prd_impl, core.cfg, prd_id)
    if not res.get("found"):
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "PRD not found"}})
    return res


def list_library(cfg, store, status, tag, cursor, limit):
    # Page over the index's per-PRD metadata. Uses the store's existing listing
    # (stored_hashes gives stems; metadata via the store's get). Falls back to a
    # vault listing if needed. Returns {results:[{id,title,status,tags,summary,source_url}], next_cursor}.
    stems = sorted(store.stored_hashes().keys())
    start = stems.index(cursor) + 1 if cursor in stems else 0
    page = stems[start:start + max(1, min(limit, 100))]
    results = [store.card_for(stem) for stem in page] if hasattr(store, "card_for") else [{"id": s} for s in page]
    next_cursor = page[-1] if len(page) == limit and (start + limit) < len(stems) else None
    return {"results": results, "next_cursor": next_cursor}
```

**Note for the implementer:** `store.card_for(stem)` is the metadata accessor; if `Store` doesn't expose it yet, add a thin `card_for` to `store.py` returning `{id,title,status,tags,summary,source_url}` from the stored metadata, and unit-test it there. The fake core's store in the test provides `card_for` (or `stored_hashes` only, exercising the fallback).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/web/test_prd_api.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/web/prd.py mcp/tests/web/test_prd_api.py
git commit -m "feat(web): PRD read router (library/search/read) over the shared core, offloaded"
```

---

### Task 5: Chat models + Alembic migration (`chatmodels.py`)

**Files:**
- Create: `mcp/prd_mcp/web/chatmodels.py`
- Create: `migrations/versions/<rev>_chat_tables.py`
- Test: `mcp/tests/web/test_chatmodels.py`

**Interfaces:**
- Consumes: Phase 2's `Base` (`prd_mcp/web/db.py`), `User` (`prd_mcp/web/models.py`).
- Produces: `Conversation`, `Message` ORM classes matching spec §4 (with `seq`, `generating`, `finish_reason`).

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/web/test_chatmodels.py
import pytest
from sqlalchemy import select
from prd_mcp.web.chatmodels import Conversation, Message


@pytest.mark.asyncio
async def test_conversation_message_persist_and_cascade(db_session, make_user):
    user = await make_user(email="a@ringkas.co.id")
    conv = Conversation(user_id=user.id, title="")
    db_session.add(conv)
    await db_session.flush()
    db_session.add_all([
        Message(conversation_id=conv.id, seq=1, role="user", content="hi"),
        Message(conversation_id=conv.id, seq=2, role="assistant", content="hello",
                sources=[], grounded=True, finish_reason="complete"),
    ])
    await db_session.commit()
    rows = (await db_session.execute(
        select(Message).where(Message.conversation_id == conv.id).order_by(Message.seq))).scalars().all()
    assert [m.seq for m in rows] == [1, 2]
    assert rows[1].finish_reason == "complete"
```

(`db_session`/`make_user` are Phase 2 conftest fixtures over the disposable Postgres; reuse them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/web/test_chatmodels.py -v`
Expected: FAIL — `chatmodels` not found.

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/prd_mcp/web/chatmodels.py
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from prd_mcp.web.db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False, default="")
    generating: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    __table_args__ = (Index("ix_conversations_user_updated", "user_id", "updated_at"),)


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sources: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    grounded: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    finish_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    __table_args__ = (
        UniqueConstraint("conversation_id", "seq", name="uq_messages_conv_seq"),
        Index("ix_messages_conv_seq", "conversation_id", "seq"),
        CheckConstraint("role IN ('user','assistant')", name="ck_messages_role"),
    )
```

- [ ] **Step 4: Generate + verify the Alembic migration**

Run: `cd mcp && .venv/bin/alembic revision --autogenerate -m "chat tables" && .venv/bin/alembic upgrade head`
Expected: a migration creating `conversations`/`messages` with the FK/unique/index/check; `upgrade head` succeeds against the test DB. Inspect the generated file to confirm both tables, the `uq_messages_conv_seq` unique, and both FKs with `ondelete=CASCADE`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/web/test_chatmodels.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp/prd_mcp/web/chatmodels.py migrations/versions/*chat_tables.py mcp/tests/web/test_chatmodels.py
git commit -m "feat(web): Conversation/Message models + chat-tables migration (seq, generating, finish_reason)"
```

---

### Task 6: Chat router — conversations CRUD (no streaming yet)

**Files:**
- Create: `mcp/prd_mcp/web/chat.py`
- Test: `mcp/tests/web/test_chat_api.py`

**Interfaces:**
- Consumes: `current_user` (Phase 2), `get_db`, `Conversation`/`Message` (Task 5).
- Produces: `router = APIRouter(prefix="/api/chat")` with `GET /conversations`, `POST /conversations`, `GET /conversations/{id}`, `DELETE /conversations/{id}`. Ownership-scoped: a conversation not owned by the caller → **404** (not 403).

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/web/test_chat_api.py
import pytest


@pytest.mark.asyncio
async def test_create_list_get_delete_owned(client_prd_ask):
    r = await client_prd_ask.post("/api/chat/conversations", headers={"x-requested-with": "prd-app"})
    assert r.status_code == 200
    cid = r.json()["id"]
    r = await client_prd_ask.get("/api/chat/conversations")
    assert any(c["id"] == cid for c in r.json())
    r = await client_prd_ask.get(f"/api/chat/conversations/{cid}")
    assert r.status_code == 200 and r.json()["messages"] == []
    r = await client_prd_ask.delete(f"/api/chat/conversations/{cid}", headers={"x-requested-with": "prd-app"})
    assert r.status_code in (200, 204)


@pytest.mark.asyncio
async def test_other_users_conversation_is_404(client_prd_ask, other_users_conversation_id):
    r = await client_prd_ask.get(f"/api/chat/conversations/{other_users_conversation_id}")
    assert r.status_code == 404  # not 403 — never leak existence
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/web/test_chat_api.py -v -k "owned or 404"`
Expected: FAIL — `prd_mcp.web.chat` not found.

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/prd_mcp/web/chat.py
from __future__ import annotations

import uuid
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select

from prd_mcp.web.db import get_db
from prd_mcp.web.rbac import require_permission
from prd_mcp.web.models import User
from prd_mcp.web.chatmodels import Conversation, Message

router = APIRouter(prefix="/api/chat")


async def _owned_or_none(db, user: User, cid: str):
    try:
        cid_u = uuid.UUID(cid)
    except ValueError:
        return None
    row = (await db.execute(select(Conversation).where(
        Conversation.id == cid_u, Conversation.user_id == user.id))).scalar_one_or_none()
    return row


@router.get("/conversations")
async def list_conversations(user: User = Depends(require_permission("prd.ask")), db=Depends(get_db)):
    rows = (await db.execute(select(Conversation).where(Conversation.user_id == user.id)
                             .order_by(Conversation.updated_at.desc()))).scalars().all()
    return [{"id": str(c.id), "title": c.title, "updated_at": c.updated_at.isoformat()} for c in rows]


@router.post("/conversations")
async def create_conversation(user: User = Depends(require_permission("prd.ask")), db=Depends(get_db)):
    conv = Conversation(user_id=user.id, title="")
    db.add(conv)
    await db.commit()
    return {"id": str(conv.id)}


@router.get("/conversations/{cid}")
async def get_conversation(cid: str, user: User = Depends(require_permission("prd.ask")), db=Depends(get_db)):
    conv = await _owned_or_none(db, user, cid)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "conversation not found"}})
    msgs = (await db.execute(select(Message).where(Message.conversation_id == conv.id)
                             .order_by(Message.seq))).scalars().all()
    return {"id": str(conv.id), "title": conv.title,
            "messages": [{"seq": m.seq, "role": m.role, "content": m.content,
                          "sources": m.sources, "grounded": m.grounded,
                          "finish_reason": m.finish_reason} for m in msgs]}


@router.delete("/conversations/{cid}")
async def delete_conversation(cid: str, user: User = Depends(require_permission("prd.ask")), db=Depends(get_db)):
    conv = await _owned_or_none(db, user, cid)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "conversation not found"}})
    await db.execute(delete(Conversation).where(Conversation.id == conv.id))
    await db.commit()
    return JSONResponse(status_code=204, content=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/web/test_chat_api.py -v -k "owned or 404"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/web/chat.py mcp/tests/web/test_chat_api.py
git commit -m "feat(web): chat conversations CRUD (ownership-scoped, 404 on non-owned)"
```

---

### Task 7: Chat SSE streaming endpoint + test fixtures

**Files:**
- Modify: `mcp/prd_mcp/web/chat.py` (add the SSE POST + the `_next_seq`/`generating`-lock helpers)
- Create/Modify: `mcp/tests/web/conftest.py` (fixtures: `client_prd_read`, `client_prd_ask`, `client_no_perms`, `other_users_conversation_id`, fake core)
- Modify: `mcp/pyproject.toml` (add `sse-starlette`)
- Test: `mcp/tests/web/test_chat_api.py` (add streaming tests)

**Interfaces:**
- Consumes: `rewrite_query`, `answer_stream` (core), `retrieve`, `format_sources` (core), `get_core` (Task 3), `anyio.to_thread`.
- Produces: `POST /api/chat/conversations/{id}/messages` → `EventSourceResponse` emitting events `rewrite`, `sources`, `token`, `done`, `error`. Sets `generating` true (409 `conversation_busy` if already set), persists user row before streaming, assistant row after, with `finish_reason`, releasing the lock in `finally`.

- [ ] **Step 1: Write the failing test**

```python
# add to mcp/tests/web/test_chat_api.py
import pytest


@pytest.mark.asyncio
async def test_sse_stream_emits_ordered_events(client_prd_ask, conv_id, monkeypatch):
    # fake the core's retrieve to return a match, and chat_stream to yield tokens
    import prd_mcp.web.chat as chatmod
    monkeypatch.setattr(chatmod, "retrieve", lambda q, store, embed, k, th: ([_FakeR()], "match"))
    async def fake_stream(question, retrieved, verdict, fn):
        for t in ["A", "B"]:
            yield t
    monkeypatch.setattr(chatmod, "answer_stream", fake_stream)
    monkeypatch.setattr(chatmod, "rewrite_query", lambda h, l, fn: l)
    r = await client_prd_ask.post(f"/api/chat/conversations/{conv_id}/messages",
                                  json={"content": "hi"}, headers={"x-requested-with": "prd-app"})
    assert r.status_code == 200
    body = r.text
    assert body.index("event: rewrite") < body.index("event: sources") < body.index("event: token") < body.index("event: done")


@pytest.mark.asyncio
async def test_sse_requires_csrf_header(client_prd_ask, conv_id):
    r = await client_prd_ask.post(f"/api/chat/conversations/{conv_id}/messages", json={"content": "hi"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf"


@pytest.mark.asyncio
async def test_sse_busy_conversation_409(client_prd_ask, busy_conv_id):
    r = await client_prd_ask.post(f"/api/chat/conversations/{busy_conv_id}/messages",
                                  json={"content": "hi"}, headers={"x-requested-with": "prd-app"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "conversation_busy"


class _FakeR:
    doc_stem = "EP-1"; doc_id = "EP-1"; title = "T"; source_url = ""; summary = "s"; tags = []; status = ""; text = "ctx"; score = 0.5
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/web/test_chat_api.py -v -k "sse"`
Expected: FAIL — endpoint/`EventSourceResponse` not present (and `sse-starlette` not installed).

- [ ] **Step 3: Add the dependency + implement**

Add `sse-starlette` to `mcp/pyproject.toml` dependencies and `cd mcp && .venv/bin/pip install sse-starlette` (or `poetry add`).

Add to `mcp/prd_mcp/web/chat.py`:

```python
import anyio
from sqlalchemy import func, update
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel

from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.answer import rewrite_query, answer_stream, format_sources
from prd_mcp.retrieve import retrieve


class MessageIn(BaseModel):
    content: str


async def _next_seq(db, conv_id) -> int:
    cur = (await db.execute(select(func.coalesce(func.max(Message.seq), 0))
                            .where(Message.conversation_id == conv_id))).scalar_one()
    return int(cur) + 1


@router.post("/conversations/{cid}/messages")
async def post_message(cid: str, body: MessageIn,
                       user: User = Depends(require_permission("prd.ask")),
                       db=Depends(get_db), core: Core = Depends(get_core)):
    conv = await _owned_or_none(db, user, cid)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "conversation not found"}})
    if not body.content or not body.content.strip():
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": "empty message"}})

    # Claim the one-at-a-time generation lock atomically (Codex spec-review #5).
    claimed = (await db.execute(update(Conversation)
               .where(Conversation.id == conv.id, Conversation.generating.is_(False))
               .values(generating=True))).rowcount
    await db.commit()
    if not claimed:
        return JSONResponse(status_code=409, content={"error": {"code": "conversation_busy", "message": "a response is already generating"}})

    # Load history BEFORE inserting the new row (Codex spec-review #12), then persist user row.
    history_rows = (await db.execute(select(Message).where(Message.conversation_id == conv.id)
                                     .order_by(Message.seq))).scalars().all()
    history = [{"role": m.role, "content": m.content} for m in history_rows]
    user_seq = await _next_seq(db, conv.id)
    db.add(Message(conversation_id=conv.id, seq=user_seq, role="user", content=body.content))
    if conv.title == "":
        conv.title = body.content[:80]
    await db.commit()

    async def event_gen():
        acc, sources, grounded, finish = [], [], None, "complete"
        try:
            standalone = await anyio.to_thread.run_sync(rewrite_query, history, body.content, core.llm.chat)
            yield {"event": "rewrite", "data": standalone}
            results, verdict = await anyio.to_thread.run_sync(
                retrieve, standalone, core.store, core.llm.embed, core.cfg.top_k, core.cfg.score_threshold)
            sources = format_sources(results)
            grounded = verdict != "no_match"
            yield {"event": "sources", "data": __import__("json").dumps({"sources": sources, "verdict": verdict})}
            async for tok in answer_stream(body.content, results, verdict, core.llm.chat_stream):
                acc.append(tok)
                yield {"event": "token", "data": tok}
        except anyio.get_cancelled_exc_class():
            finish = "client_disconnected"
            raise
        except Exception:
            finish = "llm_error"
            yield {"event": "error", "data": "generation failed"}
        finally:
            # Persist the assistant row (best-effort) + release the lock, in a fresh txn.
            async with db.begin_nested() if db.in_transaction() else _null_ctx():
                pass
            a_seq = await _next_seq(db, conv.id)
            db.add(Message(conversation_id=conv.id, seq=a_seq, role="assistant",
                           content="".join(acc) or "", sources=sources,
                           grounded=grounded if finish == "complete" else None,
                           finish_reason=finish))
            await db.execute(update(Conversation).where(Conversation.id == conv.id)
                             .values(generating=False, updated_at=func.now()))
            await db.commit()
            if finish == "complete":
                yield {"event": "done", "data": str(a_seq)}

    return EventSourceResponse(event_gen())
```

**Implementer note (concurrency + DB session):** `get_db` yields one session for the request; holding it across a long stream is acceptable here ONLY because we do not keep an open transaction during token streaming (each `commit()` closes the txn; the stream's LLM work touches no txn). If the test client's session lifecycle complains, switch `event_gen` to open its OWN short-lived session from the sessionmaker for the final persist (preferred in production). Add `from contextlib import nullcontext as _null_ctx`. Remove the placeholder `begin_nested` block if you adopt a fresh session — it's a guard, not required logic.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/web/test_chat_api.py -v`
Expected: PASS (ordered events, CSRF 403, busy 409, plus Task 6 CRUD).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/web/chat.py mcp/tests/web/conftest.py mcp/pyproject.toml mcp/tests/web/test_chat_api.py
git commit -m "feat(web): chat SSE streaming (rewrite→sources→token→done, generating-lock, finish_reason)"
```

---

### Task 8: Status router + mount everything into `create_app`

**Files:**
- Create: `mcp/prd_mcp/web/status.py`
- Modify: `mcp/prd_mcp/web/app.py` (`create_app` gains `core=None`; mounts prd/chat/status when `core` is set)
- Modify: `mcp/prd_mcp/cli.py` (`web` subcommand builds the core + passes it)
- Test: `mcp/tests/web/test_status_api.py`

**Interfaces:**
- Consumes: `read_latest_run`, `read_run_history` from `prd_mcp.web.manifests` (Plan B, locked); `require_permission("status.view")`; `get_core` for `cfg.vault_path` + coverage from `store`.
- Produces: `router = APIRouter(prefix="/api/status")` with `GET /pipeline`, `GET /history`, `GET /coverage`.

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/web/test_status_api.py
import pytest


@pytest.mark.asyncio
async def test_pipeline_reads_latest_run(client_status_view, monkeypatch):
    import prd_mcp.web.status as statusmod
    monkeypatch.setattr(statusmod, "read_latest_run",
                        lambda vault: {"run_id": "r1", "stages": {"sync": {"ok": True}},
                                       "halted": True, "halt_reason": "enrich 0/287", "halted_at": "enrich"})
    r = await client_status_view.get("/api/status/pipeline")
    assert r.status_code == 200
    assert r.json()["halted"] is True and r.json()["halt_reason"] == "enrich 0/287"


@pytest.mark.asyncio
async def test_pipeline_no_runs_is_friendly(client_status_view, monkeypatch):
    import prd_mcp.web.status as statusmod
    monkeypatch.setattr(statusmod, "read_latest_run", lambda vault: None)
    r = await client_status_view.get("/api/status/pipeline")
    assert r.status_code == 200 and r.json()["run_id"] is None


@pytest.mark.asyncio
async def test_status_requires_permission(client_prd_read):
    r = await client_prd_read.get("/api/status/pipeline")
    assert r.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/web/test_status_api.py -v`
Expected: FAIL — `prd_mcp.web.status` not found.

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/prd_mcp/web/status.py
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.web.rbac import require_permission
from prd_mcp.web.manifests import read_latest_run, read_run_history

router = APIRouter(prefix="/api/status")


@router.get("/pipeline")
async def pipeline(core: Core = Depends(get_core), _=Depends(require_permission("status.view"))):
    latest = read_latest_run(core.cfg.vault_path)
    if latest is None:
        return {"run_id": None, "stages": {}, "halted": False, "halt_reason": None, "halted_at": None}
    return latest


@router.get("/history")
async def history(limit: int = Query(10), core: Core = Depends(get_core),
                  _=Depends(require_permission("status.view"))):
    return {"runs": read_run_history(core.cfg.vault_path, limit)}


@router.get("/coverage")
async def coverage(core: Core = Depends(get_core), _=Depends(require_permission("status.view"))):
    # total PRDs vs how many are enriched (have a body_hash in the index)
    hashes = core.store.stored_hashes()
    total = len(hashes)
    enriched = sum(1 for h in hashes.values() if h)
    return {"total": total, "enriched": enriched, "unenriched": total - enriched}
```

Then wire `create_app` to mount the three routers when a core is provided. In `mcp/prd_mcp/web/app.py`, change the signature and add the includes after the existing `auth_router`/`admin_router` includes:

```python
def create_app(settings: WebSettings, sessionmaker, *, run_startup: bool = True, core=None) -> FastAPI:
    ...
    app.include_router(auth_router)
    app.include_router(admin_router)
    if core is not None:
        from prd_mcp.web.coredeps import set_core
        from prd_mcp.web.prd import router as prd_router
        from prd_mcp.web.chat import router as chat_router
        from prd_mcp.web.status import router as status_router
        set_core(app, core)
        app.include_router(prd_router)
        app.include_router(chat_router)
        app.include_router(status_router)
```

Then in `cli.py`'s `web` branch, build the core and pass it. Replace the `web` block to also construct cfg/store/llm (the same way `index`/`serve` do):

```python
    if args.cmd == "web":
        import uvicorn
        from prd_mcp.web.settings import load_settings
        from prd_mcp.web.db import make_engine, make_sessionmaker
        from prd_mcp.web.app import create_app
        from prd_mcp.web.coredeps import Core

        web_settings = load_settings()
        engine = make_engine(web_settings.database_url)
        sm = make_sessionmaker(engine)
        # Build the PRD core for the HTTP door (same cfg/store/llm as index/serve).
        if os.environ.get("PRD_SECRETS") == "env":
            from prd_mcp.env_secret import read_secret_from_env as secret_reader
        else:
            secret_reader = read_secret
        cfg = load_config(os.environ, secret_reader)
        store = Store.open(cfg.chroma_path)
        llm = make_client(cfg)
        application = create_app(web_settings, sm, run_startup=True, core=Core(cfg=cfg, store=store, llm=llm))
        uvicorn.run(application, host=args.host, port=args.port, workers=1, forwarded_allow_ips="127.0.0.1")
        return 0
```

(Note: this moves the `load_config`/`Store.open`/`make_client` imports — already imported at the top of `cli.py:1-7` — into use for the `web` path; the env-reader selection mirrors Plan B Task 5b.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/web/test_status_api.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full web test suite**

Run: `cd mcp && .venv/bin/pytest tests/web -v`
Expected: all Phase 2 + Phase 3 web tests pass together (no regressions from the `create_app` signature change — `core` defaults to None so Phase 2-only callers are unaffected).

- [ ] **Step 6: Commit**

```bash
git add mcp/prd_mcp/web/status.py mcp/prd_mcp/web/app.py mcp/prd_mcp/cli.py mcp/tests/web/test_status_api.py
git commit -m "feat(web): status router + mount prd/chat/status into create_app; web CLI builds the core"
```

---

### Task 9: Non-blocking streaming test (single-worker safety)

**Files:**
- Test: `mcp/tests/web/test_chat_concurrency.py`

**Interfaces:** none new — verifies the §5 concurrency guarantee.

**Why:** the load-bearing claim of the whole design is that one PM's long stream does NOT stall the single worker. This test makes that a regression guard.

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/web/test_chat_concurrency.py
import anyio
import pytest


@pytest.mark.asyncio
async def test_healthz_responds_during_a_slow_stream(client_prd_ask, conv_id, monkeypatch):
    import prd_mcp.web.chat as chatmod
    monkeypatch.setattr(chatmod, "rewrite_query", lambda h, l, fn: l)
    monkeypatch.setattr(chatmod, "retrieve", lambda q, s, e, k, t: ([_FakeR()], "match"))

    async def slow_stream(question, retrieved, verdict, fn):
        for t in ["x", "y", "z"]:
            await anyio.sleep(0.2)   # simulate a slow provider
            yield t
    monkeypatch.setattr(chatmod, "answer_stream", slow_stream)

    async with anyio.create_task_group() as tg:
        async def start_stream():
            await client_prd_ask.post(f"/api/chat/conversations/{conv_id}/messages",
                                      json={"content": "hi"}, headers={"x-requested-with": "prd-app"})
        tg.start_soon(start_stream)
        await anyio.sleep(0.1)  # stream is mid-flight
        with anyio.fail_after(0.5):  # /healthz must answer well before the stream finishes
            r = await client_prd_ask.get("/healthz")
            assert r.status_code in (200, 503)


class _FakeR:
    doc_stem = "EP-1"; doc_id = "EP-1"; title = "T"; source_url = ""; summary = "s"; tags = []; status = ""; text = "ctx"; score = 0.5
```

- [ ] **Step 2: Run test to verify it fails (or reveals blocking)**

Run: `cd mcp && .venv/bin/pytest tests/web/test_chat_concurrency.py -v`
Expected: FAIL if any sync core call blocks the loop; PASS once all sync calls are `to_thread`-offloaded and the stream is async (Task 7). If it fails, the fix is to ensure NO un-offloaded sync core call remains in the request path.

- [ ] **Step 3: Make it pass**

If RED: audit `chat.py` for any direct sync core call not wrapped in `anyio.to_thread.run_sync`, and confirm `answer_stream`/`chat_stream` are async. No new production code should be needed if Task 7 was done correctly — this task is the proof.

- [ ] **Step 4: Commit**

```bash
git add mcp/tests/web/test_chat_concurrency.py
git commit -m "test(web): /healthz stays responsive during a slow chat stream (single-worker safety)"
```

---

## Deploy Notes (incremental over Phase 2)

- **New dependency:** `sse-starlette` added to `mcp/pyproject.toml` — rebuild the container image.
- **Migration:** `alembic upgrade head` (now includes the chat tables) runs on deploy, as Phase 2 already does.
- **LLM keys in the web container** (spec §8, acknowledged tradeoff): the `web` command now builds the PRD core, so the container's `.env` gains `OPENAI_API_KEY` + the MiniMax key + `VAULT_PATH`/`CHROMA_PATH` + `PRD_SECRETS=env`. Provider spend limits + no-logging as per spec §8.
- **Vault/index reachable by the web container:** the Status `coverage` + PRD read/search need the `.chroma-mcp` store and (for read) the vault. On the single box these are local paths shared with the pipeline (Plan B). Mount/point `CHROMA_PATH` + `VAULT_PATH` at the same locations the orchestrator writes.

---

## Self-Review

**Spec coverage (against the design doc):**
- Core: `rewrite_query` (Task 1), async `answer_stream` + `chat_stream` (Task 2) — §3. ✓
- PRD read API library/search/read (Task 4) — §5. ✓
- Chat models seq/generating/finish_reason (Task 5), CRUD ownership-404 (Task 6), SSE rewrite→sources→token→done + generating-lock + finish_reason + history-before-insert + CSRF (Task 7) — §4, §5. ✓
- Status API over Plan B manifests + coverage (Task 8) — §5, §6. ✓
- Single-worker non-blocking proof (Task 9) — §5. ✓
- Mount into Phase 2 app, core threaded via cli `web` (Tasks 3, 8) — §3. ✓
- Deploy: sse-starlette, LLM keys in web container, vault/chroma paths — §8. ✓

**Placeholder scan:** the one soft spot is `store.card_for` (Task 4) and the chat session-lifecycle note (Task 7) — both are called out explicitly with a concrete fallback and an implementer note, not left as "TBD". No bare TODO/TBD. The library listing has a defined fallback. ✓

**Type/interface consistency:** `Core(cfg,store,llm)` defined Task 3, used Tasks 4/7/8; `search_prds_impl(cfg,store,llm,query,k)`/`keyword_search_impl(...)`/`read_prd_impl(cfg,prd_id)` match `server.py` (verified); `retrieve(query, store, embed_fn, k, threshold)` matches `retrieve.py` (verified); `format_sources`/`build_messages` reused from `answer.py` (verified); `read_latest_run`/`read_run_history` match Plan B's locked names; `require_permission`/`current_user`/`get_db`/`create_app` match Phase 2 (verified). ✓

**Cross-plan dependencies:** Plan B (`manifests.py`) must be merged before Task 8. Phase 2 (auth) must be merged before any task. Plan C (frontend) consumes these endpoint shapes.

**Known soft spots flagged for the implementer (not placeholders — decisions with a default):**
1. `store.card_for(stem)` — add to `store.py` if absent (Task 4 note), with a `stored_hashes`-only fallback.
2. Chat streaming DB-session lifecycle (Task 7 note) — prefer a fresh short-lived session for the final persist in production; the request-scoped session is acceptable because no txn is held across the stream.
