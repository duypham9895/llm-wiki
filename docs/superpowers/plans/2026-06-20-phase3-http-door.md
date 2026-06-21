# Phase 3 — Python HTTP Door (PRD / Chat / Status APIs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the HTTP/JSON door that serves the dashboard — Library/Search/Ask/Status — by mounting PRD, Chat (SSE streaming), and Status routers into Phase 2's existing FastAPI app, over the **same** shared PRD core (one brain, two doors). Adds streaming + multi-turn chat to the core (the first time Phase 3 touches it).

**Architecture:** The shared core (`mcp/prd_mcp/`) gains `rewrite_query`, `answer_stream`, and an async `chat_stream`. Three new routers in `mcp/prd_mcp/web/` (prd, chat, status) call the core's existing `_impl` functions and the new streaming ones, each behind Phase 2's `require_permission(...)`. Chat history lives in two new tables in the same `prd_auth` Postgres. The Status router reads the run-manifests Plan B writes.

**Tech Stack:** Python 3 (FastAPI, async SQLAlchemy, pydantic-settings, argon2 — all already in Phase 2), `httpx` (already used), `anyio` (ships with Starlette), `sse-starlette` (new dep) for SSE. pytest + async httpx test client + disposable Postgres (Phase 2's conftest). No live LLM/embed/Chroma in tests.

## Global Constraints

- **HARD DEPENDENCY — Phase 2 must be merged** (tasks 5–11 of the auth build) before ANY task here. This plan consumes, verbatim: `require_permission(name)` and `current_user` (`prd_mcp/web/rbac.py`), `get_db` (`prd_mcp/web/db.py`), `create_app(settings, sessionmaker, *, run_startup=True)` and the `{error:{code,message}}` envelope + `CSRFMiddleware` (`prd_mcp/web/app.py`), `WebSettings` + `load_settings` (`prd_mcp/web/settings.py`), the `Base` declarative class (`prd_mcp/web/db.py`), `User` model (`prd_mcp/web/models.py`).
- **HARD DEPENDENCY — Plan B (pipeline orchestrator) must be merged** before Task 8 (Status) and Task 8's `web` CLI wiring. Plan B creates BOTH modules this plan imports: `prd_mcp/web/manifests.py` (`read_latest_run`, `read_run_history` — Codex-SHIP locked interface) AND `prd_mcp/env_secret.py` (`read_secret_from_env`, used by the `web` CLI under `PRD_SECRETS=env`). **Task 0 (preflight) below asserts both exist before this plan runs** — do not re-create them here (Codex #1, #2).
- **Execution order:** Phase 2 merged → Plan B merged → this plan. The preflight (Task 0) fails fast if either dependency is missing.
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

### Task 0: Preflight — assert cross-plan dependencies exist

**Files:** none created — a gate before implementation.

**Why (Codex #1, #2):** this plan imports `prd_mcp.web.manifests` (Status) and `prd_mcp.env_secret` (web CLI), both authored by Plan B, and the whole Phase 2 web package. If Plan B or Phase 2 isn't merged into this checkout, several tasks import-fail at runtime. Verify before starting.

- [ ] **Step 1: Verify Phase 2 + Plan B modules are present**

Run:
```bash
cd mcp && .venv/bin/python -c "
import prd_mcp.web.app, prd_mcp.web.rbac, prd_mcp.web.db, prd_mcp.web.models, prd_mcp.web.settings
import prd_mcp.web.manifests   # Plan B
import prd_mcp.env_secret      # Plan B
from prd_mcp.web.manifests import read_latest_run, read_run_history
from prd_mcp.env_secret import read_secret_from_env
from prd_mcp.web.rbac import require_permission, current_user, PERMISSIONS
assert {'prd.read','prd.ask','status.view'} <= set(PERMISSIONS)
print('preflight OK')
"
```
Expected: `preflight OK`. If any import fails, STOP — merge Phase 2 and/or Plan B first; do not proceed.

---

### Task 0.5: Web test fixtures (concrete, before any dependent test) — Codex #8

**Files:**
- Modify: `mcp/tests/web/conftest.py` (add ALL Phase-3 web fixtures used by Tasks 4/6/7/8/9)

**Why:** the existing `conftest.py` provides only `app`/`client` (+ Phase 2's `db_session`/`make_user`). Tasks 4/6/7/8/9 need permission-scoped clients, a fake core on the app, and chat fixtures. Define them ALL here, up front, so every later test task is runnable independently and in any order.

**GROUNDED in the REAL `conftest.py` (Codex #8 + new[blocker]).** The actual Phase 2 conftest provides: `settings`, `engine`, `sessionmaker_`, `db`, `app`, `client`, `base_env` — and **no `make_user`** (Phase 2 tests build `User(...)` inline and append `Role`/`Permission` objects to `u.roles`, per `tests/web/test_invariants.py`). So this task adds a real `make_user_with_perms` helper + the Phase-3 fixtures, using the real fixture names. **Ordering:** this task is authored here but its fixtures import `coredeps` (Task 3), `chatmodels` (Task 5), and `create_app(core=...)` (Task 8) — so it must LAND after Tasks 3, 5, 8. (It's numbered 0.5 for narrative grouping, but in execution order run it after Task 8. The early tests in Tasks 4/6 that need only `client_prd_read`/`client_prd_ask` can use a minimal inline fixture until 0.5 lands — or simply order 0.5 before 4/6 and accept that 3/5/8's modules must exist first. Recommended concrete order: 1, 2, 3, 5, 8, 0.5, 4, 6, 7, 9.)**

**Interfaces produced (fixtures):** `make_user_with_perms` (helper), `app_with_core`, `fake_core`, `client_prd_read`, `client_prd_ask`, `client_status_view`, `client_no_perms`, `ask_user`, `conv_id`, `busy_conv_id`, `other_users_conversation_id`.

- [ ] **Step 1: Implement the fixtures (against the real conftest surface)**

Add to `mcp/tests/web/conftest.py`:

```python
# --- Phase 3 web fixtures ---
import httpx
import pytest_asyncio
from prd_mcp.web.app import create_app
from prd_mcp.web.coredeps import Core            # Task 3
from prd_mcp.web.rbac import current_user
from prd_mcp.web.models import User, Role, Permission
from prd_mcp.web.chatmodels import Conversation  # Task 5


async def make_user_with_perms(db, email: str, perms: set[str], status: str = "active") -> User:
    """Create an active user holding exactly `perms` via a dedicated role + permission rows,
    mirroring tests/web/test_invariants.py. effective_permissions(user) will return `perms`."""
    user = User(email=email, password_hash="x", status=status)
    if perms:
        role = Role(name=f"role_{email.split('@')[0]}")
        for name in sorted(perms):
            # reuse an existing Permission row if present, else create it
            existing = (await db.execute(
                __import__("sqlalchemy").select(Permission).where(Permission.name == name))).scalar_one_or_none()
            role.permissions.append(existing or Permission(name=name))
        user.roles.append(role)
        db.add(role)
    db.add(user)
    await db.flush()
    return user


def _fake_core():
    class FakeStore:
        def stored_hashes(self): return {"EP-1": "h", "EP-2": ""}
        def list_cards(self, status=None, tag=None, cursor=None, limit=50):
            return {"results": [{"id": "EP-1", "title": "T", "status": "active", "tags": [], "summary": "s", "source_url": ""}], "next_cursor": None}
    class FakeLlm:
        def embed(self, texts): return [[0.1, 0.2]]
        def chat(self, messages): return "rewritten"
        async def chat_stream(self, messages, **kw):
            for t in ["a", "b"]:
                yield t
    class FakeCfg:
        prds_dir = "/tmp/prds"; score_threshold = -0.15; top_k = 8; vault_path = "/tmp/vault"; chroma_path = "/tmp/chroma"
    return Core(cfg=FakeCfg(), store=FakeStore(), llm=FakeLlm())


@pytest_asyncio.fixture
def fake_core():
    return _fake_core()


@pytest_asyncio.fixture
async def app_with_core(settings, sessionmaker_, fake_core):
    # mirrors the existing `app` fixture but with the PRD core mounted
    db_mod.set_sessionmaker(sessionmaker_)
    application = create_app(settings, sessionmaker_, run_startup=False, core=fake_core)
    async with sessionmaker_() as s:
        await seed_mod.run_seed(s, settings)
    return application


def _perm_client(app, user):
    async def _cu():
        return user
    app.dependency_overrides[current_user] = _cu  # exercises the REAL require_permission guard
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test",
                             headers={"X-Requested-With": "prd-app"})


@pytest_asyncio.fixture
async def client_prd_read(app_with_core, db):
    user = await make_user_with_perms(db, "reader@ringkas.co.id", {"prd.read"}); await db.commit()
    async with _perm_client(app_with_core, user) as c:
        yield c


@pytest_asyncio.fixture
async def ask_user(db):
    user = await make_user_with_perms(db, "asker@ringkas.co.id", {"prd.read", "prd.ask"}); await db.commit()
    return user


@pytest_asyncio.fixture
async def client_prd_ask(app_with_core, ask_user):
    async with _perm_client(app_with_core, ask_user) as c:
        yield c


@pytest_asyncio.fixture
async def client_status_view(app_with_core, db):
    user = await make_user_with_perms(db, "ops@ringkas.co.id", {"status.view"}); await db.commit()
    async with _perm_client(app_with_core, user) as c:
        yield c


@pytest_asyncio.fixture
async def client_no_perms(app_with_core, db):
    user = await make_user_with_perms(db, "noperm@ringkas.co.id", set()); await db.commit()
    async with _perm_client(app_with_core, user) as c:
        yield c


@pytest_asyncio.fixture
async def conv_id(db, ask_user):
    conv = Conversation(user_id=ask_user.id, title=""); db.add(conv); await db.commit()
    return str(conv.id)


@pytest_asyncio.fixture
async def busy_conv_id(db, ask_user):
    conv = Conversation(user_id=ask_user.id, title="", generating=True); db.add(conv); await db.commit()
    return str(conv.id)


@pytest_asyncio.fixture
async def other_users_conversation_id(db):
    other = await make_user_with_perms(db, "other@ringkas.co.id", {"prd.ask"}); await db.commit()
    conv = Conversation(user_id=other.id, title=""); db.add(conv); await db.commit()
    return str(conv.id)
```

**Implementer notes:**
- Uses the REAL fixtures `settings`, `sessionmaker_`, `db`, and the module-level `db_mod`/`seed_mod` already imported in conftest. No `make_user`/`db_session`/`sessionmaker_fixture` (those don't exist).
- `conv_id`/`busy_conv_id` depend on `ask_user` (the same user `client_prd_ask` authenticates as) so ownership lines up — no `app.state` coupling.
- Overriding `current_user` (not `require_permission`) means the REAL guard runs: a `client_no_perms` user genuinely lacks the perm, so `require_permission` returns 403 for real.
- `db` and `app_with_core` share `sessionmaker_`, so rows created via `db` are visible to the app's own sessions (same engine/transaction-visibility as the existing Phase 2 `app`+`client`+`db` combo).

- [ ] **Step 2: Smoke the fixtures**

Run (after Tasks 3/5/8 land): `cd mcp && .venv/bin/pytest tests/web/test_prd_api.py -q`
Expected: no `fixture '...' not found` errors; the prd-read tests resolve `client_prd_read`/`client_no_perms`.

- [ ] **Step 3: Commit**

```bash
git add mcp/tests/web/conftest.py
git commit -m "test(web): concrete Phase 3 web fixtures (real conftest surface, real-guard perm clients)"
```

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

Add to `mcp/prd_mcp/llm.py` (`LlmClient`). Make the async streamer **injectable** (`stream_opener`) so tests pass a fake transport, and add **connect-time retry** mirroring the sync `_retry` (retry the initial connection/non-2xx on 429/5xx with async backoff; do NOT retry mid-stream — once tokens flow, a drop ends the turn, which the route records as `llm_error`). This satisfies spec §3's retry promise + testability (Codex #10):

```python
# at top of llm.py
import asyncio
import json
import httpx

# inside class LlmClient — store an optional async sleeper + stream opener (defaults are real):
    def _default_stream_opener(self):
        # returns an async context manager factory for the streaming POST
        def opener(url, headers, body, timeout):
            client = httpx.AsyncClient(timeout=timeout)
            return client, client.stream("POST", url, headers=headers, json=body)
        return opener

    async def chat_stream(self, messages, stream_opener=None, async_sleep=asyncio.sleep):
        url = f"{self.cfg.minimax_base}/chat/completions"
        headers = {"content-type": "application/json", "authorization": f"Bearer {self.cfg.minimax_key}"}
        body = {"model": self.cfg.chat_model, "messages": messages, "temperature": 0.2, "stream": True}
        timeout = getattr(self.cfg, "request_timeout", 60)
        opener = stream_opener or self._default_stream_opener()

        # PHASE 1 — connect with retry (NO tokens emitted yet). We open the stream and read the
        # status line; retry ONLY here on 429/5xx or a pre-stream connect error (Codex #10). Once
        # we begin iterating tokens, we never retry — a mid-stream drop propagates to the route as
        # llm_error (the route records finish_reason='llm_error'). Each failed attempt closes its client.
        attempt = 0
        resp = client = ctx = None
        while True:
            client, ctx = opener(url, headers, body, timeout)
            try:
                resp = await ctx.__aenter__()
            except (httpx.ConnectError, httpx.ConnectTimeout) as err:
                await client.aclose()
                if attempt < self.max_retries:
                    await async_sleep(min(2 ** attempt * 0.3, 5)); attempt += 1; continue
                raise
            if resp.status_code >= 400:
                status = resp.status_code
                await ctx.__aexit__(None, None, None); await client.aclose()
                if (status == 429 or status >= 500) and attempt < self.max_retries:
                    await async_sleep(min(2 ** attempt * 0.3, 5)); attempt += 1; continue
                raise Exception(f"http {status}")
            break  # connected with a 2xx — proceed to stream (no more retries)

        # PHASE 2 — stream tokens. No retry here; close everything in finally.
        try:
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
        finally:
            await ctx.__aexit__(None, None, None)
            await client.aclose()
```

Add a light unit test (fake `stream_opener` + fake `async_sleep`) asserting: (a) tokens are yielded from a fake stream; (b) a 503-then-200 opener retries once BEFORE any token and then streams (assert `async_sleep` called once); (c) a fake whose `aiter_lines` raises AFTER yielding one token does NOT retry (the exception propagates, no duplicate tokens) — proving mid-stream errors aren't retried; (d) the client is closed on every path. Fakes only, no network. (The `opener` returns `(client, ctx)` where `ctx` is an async context manager whose `__aenter__` yields a response-like object with `.status_code` and `.aiter_lines()`.)

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

**Note:** `search_prds_impl`/`keyword_search_impl`/`read_prd_impl` are SYNC and touch Chroma; offload them with `anyio.to_thread.run_sync` so the single worker isn't blocked. **Library (Codex #5):** there is no `store.card_for` in the real `Store`. We add a real `Store.list_cards()` method (Step 0 below) that builds one card per PRD from the per-chunk metadata the store already holds (`doc_id`, `title`, `status`, `tags`, `summary`, `source_url` — verified in `store.py:19-25`), with `status`/`tag` filtering and cursor pagination. The router calls it (offloaded). No fallback hack.

- [ ] **Step 0: Add a real `Store.list_cards` (with its own test) — Codex #5**

Add to `mcp/tests/test_store_cards.py`:

```python
from prd_mcp.store import Store


class _FakeCollection:
    def __init__(self, rows): self._rows = rows
    def get(self, include=None, where=None, limit=None):
        return {"metadatas": self._rows}


def _md(stem, status="active", tags="crm,referral"):
    return {"doc_stem": stem, "doc_id": stem, "title": f"Title {stem}", "status": status,
            "tags": tags, "summary": f"sum {stem}", "source_url": "u", "chunk_type": "summary", "body_hash": "h"}


def test_list_cards_dedupes_to_one_per_prd_and_filters():
    rows = [_md("EP-1"), _md("EP-1"), _md("EP-2", status="draft"), _md("EP-3", tags="kpr")]
    store = Store(_FakeCollection(rows))
    cards = store.list_cards()
    ids = sorted(c["id"] for c in cards["results"])
    assert ids == ["EP-1", "EP-2", "EP-3"]  # one card per PRD
    only_active = store.list_cards(status="active")
    assert all(c["status"] == "active" for c in only_active["results"])
    only_kpr = store.list_cards(tag="kpr")
    assert [c["id"] for c in only_kpr["results"]] == ["EP-3"]


def test_list_cards_paginates_by_cursor():
    rows = [_md(f"EP-{i}") for i in range(5)]
    store = Store(_FakeCollection(rows))
    page1 = store.list_cards(limit=2)
    assert len(page1["results"]) == 2 and page1["next_cursor"] is not None
    page2 = store.list_cards(limit=2, cursor=page1["next_cursor"])
    assert page1["results"][0]["id"] != page2["results"][0]["id"]
```

Add to `mcp/prd_mcp/store.py`:

```python
    def list_cards(self, status: str | None = None, tag: str | None = None,
                   cursor: str | None = None, limit: int = 50) -> dict:
        """One Library card per PRD, built from stored chunk metadata. Dedupes by
        doc_stem (a PRD has many chunks), filters by status/tag, paginates by stem cursor."""
        got = self.collection.get(include=["metadatas"])
        by_stem = {}
        for md in got.get("metadatas", []) or []:
            stem = md["doc_stem"]
            if stem in by_stem:
                continue
            tags = [t for t in (md.get("tags") or "").split(",") if t]
            by_stem[stem] = {"id": md.get("doc_id", stem), "stem": stem, "title": md.get("title", ""),
                             "status": md.get("status", ""), "tags": tags,
                             "summary": md.get("summary", "") or "", "source_url": md.get("source_url", "")}
        cards = [c for c in by_stem.values()
                 if (status is None or c["status"] == status) and (tag is None or tag in c["tags"])]
        cards.sort(key=lambda c: c["id"])
        start = next((i + 1 for i, c in enumerate(cards) if c["id"] == cursor), 0)
        limit = max(1, min(limit, 100))
        page = cards[start:start + limit]
        next_cursor = page[-1]["id"] if (start + limit) < len(cards) and page else None
        return {"results": page, "next_cursor": next_cursor}
```

Run: `cd mcp && .venv/bin/pytest tests/test_store_cards.py -v` → after implementing, PASS (2 tests).

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
        def list_cards(self, status=None, tag=None, cursor=None, limit=50):
            return {"results": [{"id": "EP-1", "title": "T", "status": "active", "tags": [], "summary": "s", "source_url": ""}], "next_cursor": None}
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

(`client_prd_read` / `client_no_perms` are defined in **Task 0.5** (conftest) — clients whose `current_user` is overridden to a real user holding `prd.read` / no perms, with the fake core on the app. Task 0.5 lands before this task, so these resolve. The `fake_core` fixture above is illustrative — the canonical one lives in conftest; you can drop the local copy and rely on `app_with_core`.)

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
    # Store.list_cards (Step 0) is sync + touches Chroma -> offload.
    return await anyio.to_thread.run_sync(
        lambda: core.store.list_cards(status=status, tag=tag, cursor=cursor, limit=limit))


@router.get("/{prd_id}")
async def read_one(prd_id: str, core: Core = Depends(get_core),
                   _=Depends(require_permission("prd.read"))):
    res = await anyio.to_thread.run_sync(read_prd_impl, core.cfg, prd_id)
    if not res.get("found"):
        return JSONResponse(status_code=404, content={"error": {"code": "not_found", "message": "PRD not found"}})
    return res
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/web/test_prd_api.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/store.py mcp/tests/test_store_cards.py mcp/prd_mcp/web/prd.py mcp/tests/web/test_prd_api.py
git commit -m "feat(web): Store.list_cards + PRD read router (library/search/read) over the shared core, offloaded"
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
# DB types + defaults mirror Phase 2's models.py EXACTLY (Codex #4): UUID PK via
# server_default text("gen_random_uuid()"), timestamps via server_default func.now(),
# seq as BigInteger. Server-side defaults so the DB (not Python) is the source of truth.
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index, String, Text,
    UniqueConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from prd_mcp.web.db import Base


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    generating: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    __table_args__ = (Index("ix_conversations_user_updated", "user_id", "updated_at"),)


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sources: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    grounded: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    finish_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    __table_args__ = (
        UniqueConstraint("conversation_id", "seq", name="uq_messages_conv_seq"),
        Index("ix_messages_conv_seq", "conversation_id", "seq"),
        CheckConstraint("role IN ('user','assistant')", name="ck_messages_role"),
    )
```

- [ ] **Step 4: Register `chatmodels` with `Base.metadata` (Alembic + tests) — Codex #3**

Autogenerate and the test metadata only see models that have been IMPORTED. `migrations/env.py:13` imports `prd_mcp.web.db.Base` and (transitively) `prd_mcp.web.models`, but NOT `chatmodels`; `mcp/tests/web/conftest.py:13` has an F401 import to register tables on `Base.metadata`. Add the import in BOTH places so the new tables are seen.

In `migrations/env.py`, after the existing `from prd_mcp.web.db import Base` line, add:
```python
import prd_mcp.web.models  # noqa: F401  (register auth tables on Base.metadata)
import prd_mcp.web.chatmodels  # noqa: F401  (register chat tables on Base.metadata)
```

In `mcp/tests/web/conftest.py`, alongside the existing table-registration import, add:
```python
import prd_mcp.web.chatmodels  # noqa: F401  (register chat tables for create_all)
```

- [ ] **Step 5: Generate + verify the Alembic migration**

Run: `cd mcp && .venv/bin/alembic revision --autogenerate -m "chat tables" && .venv/bin/alembic upgrade head`
Expected: a migration creating `conversations`/`messages` with the FK/unique/index/check; `upgrade head` succeeds against the test DB. Inspect the generated file to confirm both tables appear (they will NOT if Step 4 was skipped), the `uq_messages_conv_seq` unique, `seq` as `BigInteger`, the server defaults (`gen_random_uuid()`, `now()`), and both FKs with `ondelete=CASCADE`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/web/test_chatmodels.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add mcp/prd_mcp/web/chatmodels.py migrations/env.py migrations/versions/*chat_tables.py mcp/tests/web/conftest.py mcp/tests/web/test_chatmodels.py
git commit -m "feat(web): Conversation/Message models + chat-tables migration (seq bigint, server defaults)"
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

    conv_id_val = conv.id  # capture before the request session goes away

    async def event_gen():
        acc, sources, grounded, finish = [], [], None, "complete"
        try:
            standalone = await anyio.to_thread.run_sync(rewrite_query, history, body.content, core.llm.chat)
            yield {"event": "rewrite", "data": standalone}
            results, verdict = await anyio.to_thread.run_sync(
                retrieve, standalone, core.store, core.llm.embed, core.cfg.top_k, core.cfg.score_threshold)
            sources = format_sources(results)
            grounded = verdict != "no_match"
            yield {"event": "sources", "data": json.dumps({"sources": sources, "verdict": verdict})}
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
            # Codex #9: do NOT reuse the request-scoped `db` here — it may be closing as the
            # response streams. Open a FRESH short-lived session for the final persist + lock
            # release, so this is correct regardless of the request session's lifecycle.
            async with db_mod._sessionmaker() as s:  # the live sessionmaker set in create_app
                a_seq = (await s.execute(
                    select(func.coalesce(func.max(Message.seq), 0)).where(Message.conversation_id == conv_id_val))).scalar_one() + 1
                s.add(Message(conversation_id=conv_id_val, seq=a_seq, role="assistant",
                              content="".join(acc) or "", sources=sources,
                              grounded=grounded if finish == "complete" else None,
                              finish_reason=finish))
                await s.execute(update(Conversation).where(Conversation.id == conv_id_val)
                                .values(generating=False, updated_at=func.now()))
                await s.commit()
            if finish == "complete":
                yield {"event": "done", "data": str(a_seq)}

    return EventSourceResponse(event_gen())
```

**Implementer note (DB session lifecycle — Codex #9, resolved):** the SSE generator runs AFTER the route returns its response object, so the request-scoped `db` (from `get_db`) may already be closing. Therefore the final assistant-row persist + lock release open a **fresh** session from the live sessionmaker (`db_mod._sessionmaker()`), not `db`. The pre-stream work (claim lock, load history, persist user row) DOES use the request `db` and is fully committed before streaming starts. Add `import json` and `from prd_mcp.web import db as db_mod` at the top of `chat.py`. There is NO `begin_nested`/`nullcontext` placeholder — it's removed.

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

import anyio
from fastapi import APIRouter, Depends, Query

from prd_mcp.web.coredeps import Core, get_core
from prd_mcp.web.rbac import require_permission
from prd_mcp.web.manifests import read_latest_run, read_run_history

router = APIRouter(prefix="/api/status")


@router.get("/pipeline")
async def pipeline(core: Core = Depends(get_core), _=Depends(require_permission("status.view"))):
    # read_latest_run does filesystem I/O -> offload (Codex #6).
    latest = await anyio.to_thread.run_sync(read_latest_run, core.cfg.vault_path)
    if latest is None:
        return {"run_id": None, "stages": {}, "halted": False, "halt_reason": None, "halted_at": None}
    return latest


@router.get("/history")
async def history(limit: int = Query(10), core: Core = Depends(get_core),
                  _=Depends(require_permission("status.view"))):
    runs = await anyio.to_thread.run_sync(read_run_history, core.cfg.vault_path, limit)
    return {"runs": runs}


@router.get("/coverage")
async def coverage(core: Core = Depends(get_core), _=Depends(require_permission("status.view"))):
    # total PRDs vs how many are enriched (have a body_hash in the index).
    # store.stored_hashes() hits Chroma -> offload (Codex #6).
    hashes = await anyio.to_thread.run_sync(core.store.stored_hashes)
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
            from prd_mcp.env_secret import read_secret_from_env as secret_reader  # from Plan B (Task 5b)
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
import threading
import time
import anyio
import pytest


@pytest.mark.asyncio
async def test_healthz_responds_while_BLOCKING_sync_core_is_in_flight(client_prd_ask, conv_id, monkeypatch):
    # Codex #7: the sync core calls must be BLOCKING fakes (time.sleep), NOT fast lambdas —
    # otherwise the test passes even if the route ran them on the event loop. The route MUST
    # offload them via anyio.to_thread.run_sync for /healthz to stay responsive.
    import prd_mcp.web.chat as chatmod

    # Two events make this DETERMINISTIC (Codex iter-4): `entered` signals the blocking core
    # call has begun; `release` keeps it blocked until the test explicitly lets go. So /healthz
    # is probed while the block is PROVABLY in flight — no timing window can let it slip past.
    entered = threading.Event()
    release = threading.Event()

    def blocking_rewrite(history, latest, fn):
        entered.set()              # the blocking section is now executing
        release.wait(5.0)          # hold here until the test releases us (block stays in flight)
        return latest
    def blocking_retrieve(q, store, embed, k, th):
        return ([_FakeR()], "match")
    async def fast_stream(question, retrieved, verdict, fn):
        yield "ok"
    monkeypatch.setattr(chatmod, "rewrite_query", blocking_rewrite)
    monkeypatch.setattr(chatmod, "retrieve", blocking_retrieve)
    monkeypatch.setattr(chatmod, "answer_stream", fast_stream)

    async with anyio.create_task_group() as tg:
        async def start_stream():
            await client_prd_ask.post(f"/api/chat/conversations/{conv_id}/messages",
                                      json={"content": "hi"}, headers={"x-requested-with": "prd-app"})
        tg.start_soon(start_stream)
        try:
            # Wait (in a worker thread, so the loop stays free) until the blocking call is ENTERED.
            assert await anyio.to_thread.run_sync(entered.wait, 2.0), "stream never reached rewrite_query"
            # The block is HELD OPEN right now (release not yet set). If the route ran rewrite ON
            # the loop, the loop is frozen and /healthz cannot complete until we release. We time
            # /healthz WHILE the block is held: correct (offloaded) design answers in ms; a blocking
            # design cannot answer at all within the window.
            h0 = time.monotonic()
            with anyio.fail_after(1.0):  # a blocked loop would hang here until release -> test fails
                r = await client_prd_ask.get("/healthz")
            h_elapsed = time.monotonic() - h0
            assert r.status_code in (200, 503)
            assert h_elapsed < 0.3, f"/healthz blocked {h_elapsed:.2f}s — event loop was blocked (no offload)"
        finally:
            release.set()  # let the held blocking call finish so the stream task can complete


class _FakeR:
    doc_stem = "EP-1"; doc_id = "EP-1"; title = "T"; source_url = ""; summary = "s"; tags = []; status = ""; text = "ctx"; score = 0.5
```

**Why this is now deterministic (Codex iter-4 "stronger" fix):** the prior versions inferred "the block is in flight" from timing; this version *guarantees* it. `blocking_rewrite` sets `entered` and then parks on `release.wait()`, so the blocking call stays in flight indefinitely until the test chooses to release it. The test waits for `entered` (in a worker thread → loop stays free), then probes `/healthz` **while the block is provably held**. In the correct offloaded design, `rewrite` runs in a worker thread, the loop is free, and `/healthz` returns in milliseconds. In a non-offloaded design, the loop is frozen inside `time`-less `release.wait()` and `/healthz` cannot complete — `fail_after(1.0)` trips and the test fails. The `finally: release.set()` lets the stream finish so the task group exits cleanly. No fixed-sleep assumption, no window between the two core calls.

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

**Placeholder scan:** the two soft spots from the first draft are now resolved concretely — `Store.list_cards` is a real method with a test (Task 4 Step 0), and the chat session-lifecycle uses a fresh sessionmaker session (Task 7), with the placeholder removed. No bare TODO/TBD. ✓

**Type/interface consistency:** `Core(cfg,store,llm)` defined Task 3, used Tasks 4/7/8; `search_prds_impl(cfg,store,llm,query,k)`/`keyword_search_impl(...)`/`read_prd_impl(cfg,prd_id)` match `server.py` (verified); `retrieve(query, store, embed_fn, k, threshold)` matches `retrieve.py` (verified); `format_sources`/`build_messages` reused from `answer.py` (verified); `read_latest_run`/`read_run_history` match Plan B's locked names; `require_permission`/`current_user`/`get_db`/`create_app` match Phase 2 (verified). ✓

**Cross-plan dependencies:** Plan B (`manifests.py`) must be merged before Task 8. Phase 2 (auth) must be merged before any task. Plan C (frontend) consumes these endpoint shapes.

**Codex review iteration 1 (10 findings) — all addressed:**
- #1 (env_secret module) — Task 0 preflight asserts Plan B's `env_secret.py` exists; the `web` CLI imports it, doesn't redefine it.
- #2 (manifests module) — Task 0 preflight asserts Plan B's `manifests.py` exists; Global Constraints make Plan B a hard pre-dependency.
- #3 (Alembic/test metadata blind to chatmodels) — Task 5 Step 4 imports `chatmodels` in `migrations/env.py` AND `conftest.py`.
- #4 (DB types/defaults) — Task 5 uses `BigInteger` seq + `server_default=text("gen_random_uuid()")`/`func.now()`, matching Phase 2 `models.py`.
- #5 (`store.card_for` absent) — Task 4 Step 0 adds a real `Store.list_cards` (dedupe/filter/paginate) with its own test; router calls it offloaded.
- #6 (status sync in async route) — Task 8 offloads `read_latest_run`/`read_run_history`/`stored_hashes` via `anyio.to_thread`.
- #7 (concurrency test didn't prove offloading) — Task 9 now uses BLOCKING `time.sleep` sync fakes so `/healthz` only stays responsive if the route offloaded.
- #8 (fixtures not concrete/ordered) — Task 0.5 defines ALL web fixtures up front (clients per permission, `conv_id`, `busy_conv_id`, `other_users_conversation_id`).
- #9 (streaming DB lifecycle) — Task 7 opens a FRESH sessionmaker session for the final persist; `begin_nested`/`nullcontext` placeholder removed.
- #10 (`chat_stream` retry/injectability) — Task 2 makes it injectable (`stream_opener`/`async_sleep`) with connect-time retry mirroring sync `_retry`, plus a fake-transport unit test.

**Codex review iteration 2 (7 fixed, 3 partial + 3 new) — all addressed:**
- #7 / new[major] (concurrency test timing window) — Task 9 now measures wall-clock from before the stream starts and asserts `/healthz` completes in <0.5s (a blocked loop would delay even reaching/finishing the call); no late-starting `fail_after`.
- #8 / new[blocker] (fixtures not real) — Task 0.5 rewritten against the REAL conftest (`settings`/`sessionmaker_`/`db`/`db_mod`/`seed_mod`); adds a real `make_user_with_perms` helper (no nonexistent `make_user`); `conv_id`/`busy_conv_id` depend on `ask_user`, not `app.state`; explicit land-order note (after Tasks 3/5/8).
- #10 / new[major] (mid-stream retry + client leak) — Task 2 `chat_stream` split into PHASE 1 (connect, retry-only) and PHASE 2 (stream, no retry); client closed in `finally` on every path; test asserts a post-first-token error does NOT retry.

**Codex review iterations 3–4 (B, C SHIP; A hardened to deterministic) — addressed:**
- A (concurrency-test timing) — Task 9 final form uses TWO events: `entered` (blocking call has begun) + `release` (held open until the test lets go). `blocking_rewrite` sets `entered` then parks on `release.wait()`, so the block is PROVABLY in flight while `/healthz` is probed under `fail_after(1.0)`. A non-offloaded loop hangs → `fail_after` trips → test fails; an offloaded loop answers in ms. Fully deterministic — no fixed-sleep/timing-window assumption (Codex iter-3 then iter-4 "stronger" fix).

**Execution dependency:** Phase 2 merged → Plan B merged → Task 0 preflight → this plan. **Within this plan, run order:** 1, 2, 3, 5, 8, 0.5, 4, 6, 7, 9 (fixtures in 0.5 need coredeps/chatmodels/create_app(core=) from 3/5/8).
