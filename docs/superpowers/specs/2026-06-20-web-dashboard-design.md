# Web Dashboard (v2 Phase 3) — Design

**Date:** 2026-06-20
**Status:** Draft — in Claude+Codex cross-review loop, then user approval.
**Scope:** A React + Vite + Tailwind SPA with **Library · Search · Ask · Status** tabs plus an
**Admin** area (Users/Roles/Settings), served by a FastAPI HTTP door that extends Phase 2's auth app
and wraps the **same** shared PRD core (one brain, two doors: MCP + HTTP). Adds multi-turn streaming
chat (retires Open WebUI), pipeline **run-manifests** + a **chain guard**, and moves the A→B→C
pipeline to the `openclaw` VPS for 24/7 operation.
**Roadmap:** Phase 3 of `2026-06-20-llm-wiki-v2-roadmap.md` (Retrieval → Auth → **Dashboard**).
**Depends on:** Phase 1 (retrieval: `search_prds`+verdict, `keyword_search`, `read_prd`) — shipped;
Phase 2 (auth/RBAC/sessions) — in progress, must land before Phase 3 deploy.

---

## 1. Context & Position

Phase 1 gave agents `search_prds` (with `verdict`), `keyword_search`, `read_prd`. Phase 2 builds the
auth foundation (Postgres users/roles/sessions, RBAC, domain allowlist, registration toggle, admin
approval lifecycle) on the `openclaw` VPS behind Caddy. Phase 3 is the **human surface**: the React
dashboard PMs actually open, gated by Phase 2 auth, reusing the Phase 1 retrieval core verbatim.

Three problems from the roadmap that Phase 3 closes:
1. **No human surface of our own** — PMs use off-the-shelf Open WebUI for chat and have no way to
   browse/search PRDs or see system health. Phase 3 builds Library/Search/Ask/Status.
2. **The pipeline is a black box** — on 2026-06-19, enrichment (B) failed 287/287 and the chain still
   reported success, silently serving un-enriched PRDs, and nobody could see it. Phase 3 adds
   run-manifests + a chain guard + the Status tab.
3. **It only runs when the Mac is on** — A/B/C run on a MacBook via launchd. Phase 3 moves them to
   the always-on VPS.

**The "one brain" principle (inherited, load-bearing):** `server.py` is a thin MCP adapter over pure
core functions (`retrieve`, `keyword_retrieve`, `answer`, `read_prd`). Phase 3's HTTP door calls the
**same** functions — it does not reimplement retrieval or answering. This is the DRY guarantee that
keeps Claude Code's `ask_prds` and the dashboard's Ask tab behaviorally identical.

---

## 2. Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | **All three surfaces** (read: Library/Search/Ask; observability: Status+pipeline; admin: Login+Users/Roles/Settings) in one cohesive app | The stated goal is a system that "works very well end-to-end" the day Phase 3 ships. Built as one spec with sequenced sub-plans. |
| Ask depth | **Full multi-turn chat with streaming; retire Open WebUI** at end of Phase 3 | One tool, not two. Makes the dashboard the product, not a sidecar. |
| Grounding across turns | **Re-retrieve every turn + query rewriting** | Each follow-up is rewritten into a standalone search query using the conversation, then re-retrieved fresh — so "what about the bank report one?" stays grounded instead of hallucinating. Highest answer quality. |
| Chat storage | **Same `prd_auth` Postgres, new `conversations`/`messages` tables**, scoped by `user_id` FK | One DB to back up; per-user ownership by construction; reuses Phase 2's async SQLAlchemy + Alembic. |
| Chat transport | **SSE (Server-Sent Events)** for the answer stream | One-directional token push is exactly chat; works behind Caddy with no special config; core yields tokens so the MCP door can stream later too. |
| Pipeline orchestration | **Thin orchestrator wrapper + per-stage JSON run-manifests + chain guard** (halt on failed health gate) | One place owns "did the pipeline actually succeed." A failed B (0/287 enriched) blocks C instead of silently passing. Replaces 3 independent launchd jobs with one scheduled chain. |
| Pipeline host | **Move A→B→C + vault + `.chroma-mcp` to the `openclaw` VPS**, scheduled by systemd timers | 24/7 operation; Status tab reads local manifests directly (no sync-up freshness gap). One-time vault+index migration. |
| Nav shell | **Grouped left sidebar** (Knowledge / Operate / Manage) | Mirrors the RBAC permission split; sections a user can't access don't render. Scales as features grow. |
| Admin UX | **Approval inbox + Directory** sub-tabs under Users | Optimizes the recurring job (approve pending + assign role); pending is a first-class queue, directory stays uncluttered. |
| Design system | **shadcn/ui foundation + Ringkas identity** (Tailwind) | Accessible primitives we own in-repo (not a dependency); fast to a polished, consistent bar; documented for us + the AI team. |
| Language | **English only** | Consistent with the existing corpus (PRDs, HOW-IT-WORKS, system prompts); PMs work in English. |
| API integration | **Extend Phase 2's FastAPI app** — mount PRD/chat/status routers into the same `create_app()`, same container, same session+permission guards | Tightest integration, least plumbing; the web-API never re-validates sessions, it just declares `require_permission(...)`. |
| Content review | **Senior Content Writer agent** (`.claude/agents/senior-content-writer.md`) reviews every human-readable string | Third reviewer in the cross-model loop: Claude builds, Codex scrutinizes logic/security, Content Writer owns copy. Bound by Phase 2's anti-enumeration rules. |

---

## 3. Architecture & File Layout

Phase 3 **modifies the shared core for the first time** (Phases 1–2 left it untouched) to add
streaming + multi-turn, then adds an HTTP door and a frontend, and a pipeline orchestrator.

```
mcp/prd_mcp/                         SHARED CORE (extended, still MCP/web-agnostic)
  answer.py     + rewrite_query(history, latest, chat_fn) -> str   (standalone search query)
                + async answer_stream(question, retrieved, verdict, chat_stream_fn) -> AsyncIterator[str]
                  ASYNC GENERATOR, TOKEN-ONLY: `async for tok in chat_stream_fn(...)` and yields each
                  token; on no_match yields the fixed non-answer and does NOT call chat_stream_fn
                  (mirrors answer()'s short-circuit). Async because chat_stream_fn is async (below).
                  Sources/grounded
                  are NOT yielded here — the chat route already holds `retrieved`+`verdict` (step 4)
                  and builds the sources/grounded payload itself via answer.format_sources().
                  (existing answer() retained unchanged for the non-streaming MCP path)
  llm.py        + chat_stream(messages) -> AsyncIterator[str]      (async; httpx.AsyncClient.stream()
                  with stream:true + asyncio.sleep for retry backoff. The existing sync chat()/embed()
                  stay; the chat route offloads any SYNC core call it makes — rewrite_query (uses
                  sync chat()), embed(), retrieve() — via anyio.to_thread.run_sync so the event loop
                  is never blocked under the single uvicorn worker. See §5 concurrency note.)
  retrieve.py     (unchanged — reused verbatim)
  read.py         (unchanged)
  store.py        (unchanged)
  server.py       MCP door (unchanged this phase; may gain streaming later for free)

mcp/prd_mcp/web/                     PHASE 2 APP (gains routers; same app + container)
  app.py        ~ create_app() also mounts prd/chat/status routers; starts manifest reader
  prd.py    NEW   GET /api/prd/library, /api/prd/search, /api/prd/{id}      (require prd.read)
  chat.py   NEW   conversations CRUD + SSE message stream                  (require prd.ask)
  status.py NEW   GET /api/status/* — pipeline health from run-manifests   (require status.view)
  chatmodels.py NEW  Conversation, Message ORM (same prd_auth DB)
  manifests.py  NEW  read/parse/validate pipeline run-manifests from disk
  (auth.py, admin.py, rbac.py, sessions.py, models.py, security.py — Phase 2, unchanged)

mcp/web-ui/                          NEW FRONTEND (React+Vite+TS+Tailwind+shadcn)
  src/ ... pages: Library, Search, Ask, Status, Admin(Approvals/Directory/Roles/Settings), Login
  builds to static assets; Caddy serves them; SPA calls /api/* same-origin

src/                                 NODE PIPELINE (gains orchestrator + manifest emit)
  orchestrate.ts NEW  runs A→B→C in order; reads each stage's result; enforces chain guard
  index.ts      ~ A (sync) also writes a run-manifest
  enrich/enrich-index.ts ~ B (enrich) also writes a run-manifest
  (Python index job C writes its manifest too — mcp/prd_mcp/index.py or cli wrapper)

deploy/                              (extends Phase 2's deploy)
  web-api container gains LLM keys (scoped to this container only)
  systemd timers run the orchestrator; vault + .chroma-mcp live on the box
```

**Module boundaries (single-responsibility):**
- `answer.py` / `llm.py` own ALL LLM interaction (single-shot, streaming, rewrite). Both doors call them.
- `chat.py` owns conversation/message HTTP + SSE framing ONLY; it calls core functions, never the LLM directly.
- `manifests.py` is the ONLY reader of pipeline manifest files; `status.py` calls it.
- `orchestrate.ts` is the ONLY place that sequences A→B→C and decides chain-guard halts.
- The frontend never talks to the core or DB — only to `/api/*`.

---

## 4. Data Model (chat — additive to Phase 2's schema)

Two new tables in the existing `prd_auth` Postgres DB. UUID PKs, `user_id` FK to Phase 2's `users`.

```
conversations
  id          uuid        PK default gen_random_uuid()
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE
  title       text        NOT NULL DEFAULT ''        -- set from the FIRST user message (see below)
  generating  boolean     NOT NULL DEFAULT false     -- true while a stream is active (one-at-a-time guard)
  created_at  timestamptz NOT NULL DEFAULT now()
  updated_at  timestamptz NOT NULL DEFAULT now()     -- bumped on each new message
  INDEX (user_id, updated_at DESC)                   -- list a user's conversations newest-first

messages
  id              uuid        PK default gen_random_uuid()
  conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
  seq             bigint      NOT NULL               -- monotonic per-conversation order (assigned server-side)
  role            text        NOT NULL CHECK (role IN ('user','assistant'))
  content         text        NOT NULL               -- user question, or (full/partial) assistant answer text
  sources         jsonb       NOT NULL DEFAULT '[]'  -- assistant turn: [{id,title,source_url,obsidian_link}]
  grounded        boolean     NULL                   -- assistant turn: matches answer()'s grounded flag
  finish_reason   text        NULL                   -- assistant turn: 'complete'|'client_disconnected'|'llm_error'|'cancelled'
  created_at      timestamptz NOT NULL DEFAULT now()
  UNIQUE (conversation_id, seq)                      -- deterministic total order, no timestamp ties
  INDEX (conversation_id, seq)                       -- replay a conversation in order
```

**Ownership & isolation:** every conversation/message endpoint filters by the authenticated
`user_id`. A user can never read or write another user's conversation (404, not 403, to avoid
leaking existence). Deleting a user cascades their conversations + messages.

**Ordering:** messages are ordered by `seq` (a per-conversation monotonic counter assigned in the same
transaction that inserts the row), NOT by `created_at` — two rows can share a timestamp, and `seq`
gives a stable total order for replay and for building rewrite-history.

**One generation at a time:** `POST .../messages` first flips `conversations.generating` true in a
transaction (or takes a Postgres advisory lock on the conversation id); a second concurrent send on
the same conversation gets `409 conversation_busy`. The flag/lock is always released in a `finally`
(including disconnect/error), so a crashed stream can't wedge a conversation (a startup/opportunistic
sweep also clears stale `generating` flags).

**Persistence points & finish_reason:** the user message row is written (committed) before streaming;
the assistant row is written **after** the stream resolves, in a separate transaction, with
`finish_reason`: `complete` on normal end, `client_disconnected`/`cancelled` if the ASGI generator is
cancelled (best-effort persist of accumulated text in a `finally`, no further LLM spend), `llm_error`
on provider failure. `grounded` is only meaningful when `finish_reason='complete'`. This makes "what
happened to this turn" representable rather than ambiguous.

**Title:** set from the first user message (truncated) on the **first successful message** when
`title == ''` — NOT at empty-conversation create time (the create endpoint makes an empty row with no
message yet). Idempotent: later messages never overwrite a non-empty title.

---

## 5. API Contract (HTTP door)

All under `/api`, all JSON except the SSE stream. Auth via Phase 2's session cookie. Every endpoint
declares a `require_permission(...)`. Errors reuse Phase 2's envelope `{error:{code,message}}`.
All state-changing requests require Phase 2's CSRF header `X-Requested-With: prd-app`.

### PRD read (`prd.py`, requires `prd.read`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/prd/library?status=&tag=&cursor=&limit=` | Paginated PRD list for the Library tab. Reads from the index metadata (id/title/status/tags/summary/source_url). Cursor-paginated. |
| GET | `/api/prd/search?q=&mode=semantic\|keyword&k=` | Wraps `search_prds_impl` (semantic, returns `verdict`+`score`) or `keyword_search_impl` (literal). Same shapes the MCP tools return. |
| GET | `/api/prd/{id}` | Wraps `read_prd_impl` — full canonical body from the vault. `found:false` → 404. |

### Chat (`chat.py`, requires `prd.ask`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/chat/conversations` | List the current user's conversations (id, title, updated_at), newest first. |
| POST | `/api/chat/conversations` | Create an empty conversation; returns `{id}`. |
| GET | `/api/chat/conversations/{id}` | Full message history (ordered) — only if owned by the user (else 404). |
| DELETE | `/api/chat/conversations/{id}` | Delete a conversation (owned-only). |
| POST | `/api/chat/conversations/{id}/messages` | **SSE stream.** Body `{content}`. Owned-only (404 otherwise). Requires the CSRF header `X-Requested-With: prd-app` (sent via a fetch-based SSE client — see §7; a plain browser `EventSource` cannot POST a body or set headers, so it is NOT usable here). `409 conversation_busy` if a generation is already active on this conversation. Pipeline below. |

**SSE message pipeline** (`POST .../messages`, `Content-Type: text/event-stream` response):
```
1. validate ownership + non-empty content (422 if blank, no LLM call)
2. acquire the per-conversation generation lock (Postgres advisory lock keyed on conversation_id,
   OR a `conversations.generating` flag set in a transaction); if already held -> 409 conversation_busy
3. load prior turns of THIS conversation BEFORE inserting the new row (history excludes the current
   message), ordered by `seq`; THEN persist the user message row with the next `seq` (committed in its own txn)
4. standalone_query = await to_thread(rewrite_query, history, content, llm.chat)  [event: rewrite]
   (empty history -> rewrite_query returns `content` unchanged, no LLM call)
5. (results, verdict) = await to_thread(retrieve, standalone_query, store, llm.embed, top_k, threshold)
   sources = format_sources(results)                                              [event: sources {sources,verdict}]
6. if verdict == no_match: emit the fixed honest non-answer as token(s); finish_reason=complete;
   persist assistant row (grounded:false, sources:[]); [event: done]; release lock; return (no LLM call)
7. else stream: async for tok in answer_stream(content, results, verdict, llm.chat_stream):
                  [event: token {text}]   (await-driven; event loop stays free for other requests)
8. on normal completion: persist assistant row (full text + sources + grounded:true,
   finish_reason=complete) in a SEPARATE final txn  [event: done {message_id}]
9. in finally / on CancelledError (client disconnect) or provider error: persist accumulated partial
   text best-effort with finish_reason in {client_disconnected, llm_error, cancelled}; on error also
   [event: error {message}] if the connection is still open; ALWAYS release the generation lock
```
SSE event names: `rewrite`, `sources`, `token`, `done`, `error`. Heartbeat comment every ~15s to keep
the proxy connection alive. **No DB transaction is held open across the stream** — the user row, and
the final assistant row, are each their own short transaction; the long-lived part (LLM streaming)
touches no open txn.

**Concurrency under the single uvicorn worker (the load-bearing constraint).** Phase 2 mandates
`--workers 1` because its rate limiter is an in-process token bucket. A naive *synchronous* stream
would therefore block the entire app (auth/admin/status) for the duration of one PM's answer. So:
(a) `chat_stream` is **async** (`httpx.AsyncClient.stream`, `asyncio.sleep` backoff); (b) every
**sync** core call the route makes (`rewrite_query`→`chat`, `embed`, `retrieve`) is offloaded with
`anyio.to_thread.run_sync`; (c) the route is a normal async endpoint returning a
`StreamingResponse`/`EventSourceResponse`. Net: many concurrent chats and ordinary requests interleave
on the one worker. A test asserts `/healthz` and `/api/auth/me` respond promptly while a fake slow
stream is in flight.

### Status (`status.py`, requires `status.view`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status/pipeline` | Latest run-manifest per stage (A/B/C) + the orchestrator verdict: each stage's last run time, counts, success/fail, and whether the chain was halted. |
| GET | `/api/status/history?limit=` | Recent orchestrator runs (for a simple trend / "last N runs" list). |
| GET | `/api/status/coverage` | Corpus health: total PRDs, how many enriched (have summary/body_hash), how many un-enriched (the 4/287 class), index freshness. |

### Health (Phase 2, unchanged)
`GET /healthz` — liveness + DB; no auth.

---

## 6. Pipeline Run-Manifests & Chain Guard

**The incident this fixes:** A (sync), B (enrich), C (index) ran as 3 independent launchd jobs.
B failed 287/287 while the chain "reported success" and served un-enriched PRDs. Nothing connected
the stages or gated them.

**Run-manifest (one JSON per stage per run):** written to `<vault>/.runs/<run_id>/<stage>.json`.
```json
{
  "stage": "enrich",                 // "sync" | "enrich" | "index"
  "run_id": "2026-06-20T03:00:00Z",  // shared across the 3 stages of one orchestrated run
  "started_at": "...", "finished_at": "...",
  "ok": false,                       // stage's own success verdict (exit code based)
  "exit_code": 1,
  "counts": {"processed": 287, "succeeded": 0, "skipped": 0, "failed": 287},
                                     // processed = attempted this run; skipped = unchanged/up-to-date (incremental)
  "errors": ["..."],                 // bounded sample
  "health_gate": {"passed": false, "reason": "0/287 enriched (succeeded/processed 0.0 < 0.5)"}
}
```

**Counter semantics (precise, to avoid a new silent-failure class).** Each stage reports
`processed` (items it actually attempted this run), `succeeded`, `failed`, `skipped` (unchanged /
up-to-date items it intentionally did nothing to). The pipeline is **incremental** — a healthy night
with no Notion changes legitimately has `processed=0, failed=0, skipped=N`. Gates must treat that as
a PASS, not a halt, and must never divide by zero.

**The orchestrator (`orchestrate.ts`):** runs A→B→C **in sequence**; after each stage reads its
manifest and evaluates a **health gate**; if the gate fails, it **halts the chain** (does not run the
next stage), writes an orchestrator-level summary manifest, exits non-zero, AND fires the alert path
below. Health gates (tunable), each evaluated as *exit-code first, then ratio only when there is work*:
- **A (sync):** PASS if exit 0 AND `failed <= max_sync_failures` (default 0). A nonzero exit or
  `failed` over the threshold HALTS B. (One policy — no "partial sync still allowed" ambiguity: a
  sync error halts the chain by default; raise `max_sync_failures` deliberately to tolerate known-bad docs.)
- **B (enrich):** PASS if exit 0 AND ( `processed == 0` [no-op night — nothing to enrich]
  OR `failed == 0` OR `succeeded / processed >= min_success_ratio` (default 0.5) ). The 2026-06-19
  `processed=287, succeeded=0, failed=287` case FAILS (0.0 < 0.5) and halts C; a `processed=0` night PASSES.
- **C (index):** runs only if A and B gates passed; PASS if exit 0 AND the resulting index is non-empty.

**Why the guard is "block," not "warn":** the Status tab also *shows* failures, but the structural
fix is that C cannot index un-enriched docs because it never runs when B's gate fails. Visibility +
prevention, not visibility alone.

**Alerting (not just "exit non-zero").** A nonzero exit only helps if something watches. The
orchestrator's systemd service gets an `OnFailure=` unit that sends an operator notification
(Healthchecks.io ping / ntfy / email — chosen at deploy; the cheapest is a Healthchecks.io dead-man
URL the orchestrator pings on success, which alerts on BOTH failure and a missed run). The Status tab
banner is the in-app surface; the `OnFailure` hook is the push so a halted chain is not missed when
nobody opens the dashboard. A missed-run alert also covers the case where the timer itself didn't fire.

**Status tab reads manifests** via `manifests.py` (validates shape, tolerates a missing/partial run
directory → reports "no successful run yet" rather than crashing).

---

## 7. Frontend (Information Architecture & UX)

**Stack:** React + Vite + TypeScript + Tailwind + shadcn/ui + react-query (data) + a minimal router.
Builds to static files; Caddy serves them; SPA calls `/api/*` same-origin (Phase 2 cookies + CSRF
header apply natively).

**Shell:** grouped left sidebar —
- **Knowledge:** Library, Search, Ask
- **Operate:** Status
- **Manage:** Users, Roles, Settings

Sections/items render **only** if the user's permissions include the gating permission (`prd.read`,
`prd.ask`, `status.view`, `users.manage`, `roles.manage`). `GET /api/auth/me` (Phase 2) returns the
user's permissions; the SPA uses them to build the nav and guard routes (defense-in-depth — the API
still enforces server-side; the UI just doesn't show what it can't use).

**Tabs:**
- **Library** — browsable/filterable PRD grid (cards: id, title, status, tags, summary). Click → reader (full body via `/api/prd/{id}`), with source_url + obsidian_link.
- **Search** — one box, a semantic/keyword toggle (mirrors the two retrieval lanes); shows the `verdict` honestly ("No PRD covers this" on `no_match`) rather than weak hits.
- **Ask** — multi-turn streaming chat. Conversation list (left), thread (right), token-by-token answers, a **Sources** panel per answer (cited PRDs, clickable). New conversation / delete. On `no_match`, the honest non-answer. While a generation is active the send box is disabled (mirrors the server's `409 conversation_busy` one-at-a-time guard).
  **SSE client (important):** because the stream is a `POST` carrying a JSON body AND must send the CSRF header `X-Requested-With: prd-app`, the browser's native `EventSource` (GET-only, no custom headers) is **not** usable. The Ask tab uses a `fetch()`-based stream reader (`credentials:'same-origin'`, the CSRF header, reading the `ReadableStream` and parsing SSE frames) — or a fetch-based SSE library. This is a hard constraint the implementation must honor.
- **Status** — pipeline health (A/B/C last run, counts, pass/fail, chain-halt banner if the guard fired), coverage (enriched vs un-enriched), index freshness.
- **Admin** — **Approvals** (pending queue as action cards: email, requested-at, role checkboxes, Approve/Reject; inline handling of 422 `admin_pair` / 409 `last_admin`), **Directory** (active/disabled user table: disable/enable, reset-password, change roles), **Roles** (list/create/edit/delete custom roles; system roles shown locked), **Settings** (registration toggle, domain allowlist editor).
- **Login** — email+password; generic error on failure (Phase 2 anti-enumeration); no "account doesn't exist" hints.

**Copy:** all user-facing strings reviewed by the Senior Content Writer agent against its voice guide
and Phase 2's anti-enumeration constraints.

---

## 8. Deployment (extends Phase 2's openclaw setup)

- **Web-API container:** the same `prd-app` FastAPI app (Phase 2 + Phase 3 routers), single uvicorn
  worker (Phase 2's in-process rate limiter requires it — and the §5 async/offload design is what
  keeps one worker non-blocking under streaming), bound to loopback, behind Caddy. **Now also needs
  LLM + embed keys** (`OPENAI_API_KEY` for embeddings, MiniMax key for chat), added to the chmod-600
  `.env`.
  **Tradeoff acknowledged (not hand-waved):** Phase 2 deliberately kept LLM keys out of the auth
  container's blast radius. Because we chose "extend Phase 2's app" (one container), the LLM keys now
  live alongside auth/session/DB access — we are NOT splitting into a second service (that would undo
  the locked one-app decision and add cross-service session plumbing). We accept the shared blast
  radius and mitigate: (a) provider-side spend limits / budget alerts on both keys; (b) keys never
  logged and never returned in any response or error (same rule Phase 2 applies to DB creds); (c)
  least-privilege embed/chat keys (no org-admin scope); (d) the keys are read only by the core's LLM
  client, never echoed by any endpoint. If the blast radius ever proves unacceptable, splitting the
  PRD/LLM routers into an internal-only service with a narrow service token is the documented exit.
- **Frontend:** `vite build` → static assets; Caddy serves them at the dashboard origin and
  reverse-proxies `/api/*` to the loopback web-API. Same origin → Phase 2's SameSite cookies + CSRF
  header work unchanged. The server needs no Node at runtime (static files only).
- **Pipeline on the box:** Node (A/B + orchestrator) + Python (C/index) installed on the VPS; the
  vault + `.chroma-mcp` + `.runs/` live on the box. **systemd timers** run `orchestrate.ts` daily
  (replacing the Mac's launchd jobs). The orchestrator's non-zero exit on a halted chain surfaces in
  systemd status + journald AND fires the `OnFailure=` alert (see §6).
- **Secrets reading — BOTH runtimes, not just Python (this is a real migration blocker):** today the
  Node pipeline reads macOS keychain via `execFileSync('security', ...)` in TWO places —
  `src/config.ts` `readKeychainToken()` (the Notion token, service `ringkas-prd-sync`) and
  `src/enrich/enrich-config.ts` `readEnrichKey()` (the LLM key, service `ringkas-prd-enrich`). These
  fail on Linux. Both `loadConfig`/`loadEnrichConfig` already take the reader as an injected param, so
  the fix is small: add `os.environ`-backed readers (e.g. read `NOTION_TOKEN` / `LLM_API_KEY` from
  env) and wire `src/index.ts` + `src/enrich/enrich-index.ts` to use them under systemd. The Python
  core's `load_config` already takes `read_secret_fn` (verified in `config.py`) and gets the same
  env-backed treatment. **Required env on the box (`.env`/systemd):** `NOTION_TOKEN`, `LLM_API_KEY`,
  `LLM_BASE_URL`, `LLM_MODEL`, `VAULT_PATH`, `STATE_FILE`, plus the Python side's `OPENAI_API_KEY` /
  `MINIMAX_*` / `CHROMA_PATH` / embedding config. The Mac keeps its `security`-CLI readers; only the
  injected reader differs per host (one swap, not a rewrite).
- **One-time migration:** copy the current vault + `.chroma-mcp` from the Mac to the box; run one
  forced reindex if needed; cut launchd → systemd; verify the first orchestrated run writes manifests.
- **OWUI decommission:** after the Ask tab is validated in production, stop the Open WebUI container +
  its load job (`com.ringkas.prd-owui-load`). Documented as the final Phase 3 step, reversible until then.

---

## 9. Error Handling

| Situation | Behavior |
|---|---|
| PRD library/search over an empty or un-built index | Phase 1's clear "index not built" message surfaced as a friendly empty state, not a crash. |
| `search` returns `verdict: no_match` | Library/Search shows the honest "No PRD covers this" state; never weak hits dressed as matches. |
| `read_prd` unknown id | 404 with a clear "PRD not found" — never a server error. |
| Chat: conversation not owned by user | **404** (not 403) — never leak that another user's conversation exists. |
| Chat: empty/whitespace content | 422 validation; no LLM call. |
| Chat: `no_match` verdict | Honest non-answer streamed (fixed copy), `grounded:false`, **no chat LLM call** (mirrors core `answer`). |
| Chat: LLM/embed failure mid-stream | `error` SSE event + best-effort persist of the partial; the connection closes cleanly; the UI shows a retry affordance. |
| Chat: client disconnects mid-stream | Server finishes/persists best-effort; no orphaned half-written rows beyond the flagged partial. |
| Status: no successful pipeline run yet / missing manifest dir | "No run data yet" state; `manifests.py` tolerates absence, never crashes. |
| Pipeline: a stage fails its health gate | Orchestrator halts the chain, writes the summary manifest, exits non-zero; Status shows the halt + reason. |
| Any admin mutation hitting Phase 2 invariants | Surface Phase 2's codes humanely: 409 `last_admin`, 422 `admin_pair`, 409 `system_role_immutable`, 409 `role_in_use` — inline, with copy the Content Writer owns. |
| Missing CSRF header on a mutation | Phase 2's 403 `csrf`. |
| Expired/revoked session during use | Phase 2's 401 + cookie cleared; SPA redirects to Login. |

---

## 10. Testing Strategy

Python: pytest + async test client + the disposable Postgres Phase 2 set up; **fakes** for LLM/embed
(no live calls), a small fake store. Frontend: component/interaction tests (Vitest + Testing Library);
the SSE parsing logic unit-tested against a scripted event stream. Pipeline: orchestrator + manifest
logic unit-tested with fakes.

| Layer | Tests |
|---|---|
| core: rewrite_query | given a fake history + follow-up, produces a standalone query (fake chat_fn); empty history → returns the latest as-is; never calls the LLM on empty input. |
| core: answer_stream | TOKEN-ONLY: yields answer tokens from a fake chat_stream_fn; on `no_match` yields the fixed non-answer text and does NOT call chat_stream. (Sources/grounded are NOT produced by answer_stream — the chat route builds them from `retrieved`+`verdict`; a separate test asserts the route's sources payload equals `format_sources(results)`, matching the non-stream `answer()`.) |
| prd endpoints | library pagination; search semantic returns `verdict`; search keyword matches literals; `/prd/{id}` body; unknown id → 404; all require `prd.read` (403 without). |
| chat endpoints | create/list/get/delete owned-only; another user's conversation → 404; SSE emits rewrite→sources→token→done in order; `no_match` path streams non-answer + no chat call; user+assistant rows persisted with correct sources/grounded/seq; rewrite-history EXCLUDES the just-sent message; messages replay by `seq` (no timestamp-tie reorder); client-disconnect persists partial with `finish_reason='client_disconnected'`; title set from first message only when empty; all require `prd.ask`. |
| chat concurrency | a second `POST .../messages` on a conversation already generating → `409 conversation_busy`; the `generating` flag is released on normal end AND on disconnect/error (finally); a stale flag is swept on startup. |
| streaming non-blocking | with a fake slow `chat_stream`, `/healthz` and `/api/auth/me` still respond promptly while the stream is in flight (proves the async/`to_thread` offload keeps the single worker free); no DB transaction stays open across the stream. |
| SSE CSRF | `POST .../messages` WITHOUT `X-Requested-With: prd-app` → Phase 2's `403 csrf`; WITH it → streams. |
| status endpoints | reads fixture manifests → correct per-stage summary + halt flag; missing manifest dir → "no run" (no crash); coverage counts enriched vs un-enriched; requires `status.view`. |
| pipeline orchestrator | A→B→C run in order; B gate fail (0/287) HALTS C and exits non-zero; all-pass runs C; each stage writes a well-formed manifest; **B no-op night (`processed=0, failed=0`) PASSES and C still runs** (no division-by-zero, no false halt); A failure over `max_sync_failures` HALTS B per the single A policy. |
| chain guard (the incident) | the exact 287/287-enrich-fail scenario: B manifest `succeeded:0,processed:287` → orchestrator does NOT run C, writes halt summary, exits non-zero, fires `OnFailure`, Status surfaces it. Regression test for the silent-failure bug. |
| pipeline secrets on Linux | the env-backed Node readers return the Notion token / LLM key from `os.environ` (not the `security` CLI); `loadConfig`/`loadEnrichConfig` work with the injected env reader so A and B run headless on the box. |
| frontend | nav renders only permitted sections (perms from /me); Search shows no_match honestly; Ask renders streamed tokens + sources; Approvals disables Approve + explains on a would-be admin_pair; Login shows only the generic error. |
| integration (lifecycle) | login → Library list → open a PRD → Ask a question (streamed, grounded, sources) → follow-up re-retrieves → Status shows last run → logout. |

No live LLM/embed/Chroma in automated tests. Postgres is real (ownership/cascade/isolation is the
point). SSE tested by asserting the ordered event sequence from a fake core.

---

## 11. Out of Scope (Phase 3)

- **Editing PRDs from any surface** — Notion stays the editor; every surface is read-only over content.
- **Self-service password reset via email** — deferred with Phase 2 (no email provider); admin
  reset-password + self change-password remain the recovery paths.
- **Multi-tenancy** — explicitly out for all of v2.
- **WebSocket / bidirectional chat features** (typing indicators, mid-stream cancel over the socket) —
  SSE chosen; revisit only if a real need appears.
- **Query-rewriting upgrades** beyond the single rewrite call (e.g. multi-query fan-out, HyDE) —
  the single rewrite is the agreed quality bar.
- **Trend analytics / full job-state in Postgres for the pipeline** — manifests on disk + a "last N
  runs" list suffice; a `pipeline_runs` table is deferred.
- **RRF fusion of semantic+keyword inside one endpoint** — the Search tab exposes the two lanes via a
  toggle (as the MCP tools do); a fused lane is a later upgrade.
- **Audit log of admin actions** — deferred with Phase 2.

---

## 12. Build Sequence (within Phase 3, after Phase 2 lands)

1. **Core extensions** — `rewrite_query`, `answer_stream`, `llm.chat_stream` (+ tests). No UI yet; MCP unaffected.
2. **PRD read API** — `prd.py` (library/search/read) over the existing core (+ tests).
3. **Chat API** — `chatmodels.py` + Alembic migration + `chat.py` SSE pipeline (+ tests).
4. **Pipeline orchestrator + manifests** — `orchestrate.ts`, stage manifest emit, `manifests.py`, chain-guard tests (the incident regression).
5. **Status API** — `status.py` over `manifests.py` (+ tests).
6. **Frontend** — shell + nav + the five surfaces, shadcn components, SSE client, Content-Writer copy pass.
7. **Deploy** — pipeline → VPS, web-API gains LLM keys, Caddy serves the SPA, one-time migration, then OWUI decommission.

Each step is independently testable; the system is integrated and "works end-to-end" at step 6, with
step 7 making it production + 24/7.
