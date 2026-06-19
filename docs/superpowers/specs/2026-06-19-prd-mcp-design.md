# PRD MCP Server — Design

**Date:** 2026-06-19
**Status:** Design approved, pending implementation plan
**Scope:** An MCP server that lets AI agents (Claude Code, Codex) search and ask questions over the Ringkas PRD corpus.

---

## 1. Context & Position

The `llm-wiki-prd` initiative produced a PRD corpus in an Obsidian vault: **A** (Notion → Markdown sync), **B** (LLM enrichment: `llm.summary`/`tags`/`related`/`body_hash`), **C** (RAG chat via Open WebUI for humans). This MCP server adds an **agent-facing** door to the same corpus: Claude Code / Codex can call tools to *find* relevant PRDs or *ask* grounded questions, with citations.

**Key context from exploration:**
- C was implemented as **Open WebUI** (off-the-shelf), so there is **no reusable retrieval library** in the repo. The MCP therefore owns its own retrieval — which is essentially the custom `chat/` design we wrote for C (spec `2026-06-19-rag-chat-design.md`) but never built, now built here minus the UI.
- The vault (`~/Documents/Backup/Obsidian/ringkas/PRDs/*.md`) is the language-neutral source, refreshed nightly by A+B. The MCP reads it; it never writes to the vault or Notion.
- Reuses the `notion-mcp` pattern (Python MCP SDK, macOS keychain) and the verified credentials (OpenAI embeddings, MiniMax chat).

---

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Tools | **`search_prds` + `ask_prds`** | search = agent reasons over raw ranked PRDs; ask = grounded synthesized answer. Covers "find" and "chat". |
| Backend | **Direct vault + own Chroma index** (not proxying Open WebUI) | Clean raw-search results; self-contained; doesn't depend on the OWUI container; reuses the C custom design. |
| Language | **Python** | Reuses the C custom design + `notion-mcp` MCP pattern + chromadb's native client. |
| Transport | **stdio (default) + HTTP (configurable)** | stdio for local agents (Claude Code/Codex); HTTP for sharing (e.g. over Tailscale). Same tool handlers; transport is a launch flag. |
| Embeddings | **OpenAI `text-embedding-3-small`** (1536-dim) | Verified working; same as C. Key: keychain `ringkas-prd-embed`/`openai-api-key`. |
| Answer LLM | **MiniMax router** `minimax/MiniMax-M3`, `stream:false` | Same as B/C. Key: keychain `ringkas-prd-enrich`/`llm-api-key`. |
| Index refresh | **Own incremental indexer** (`prd-mcp index`), chained nightly (~12:20, after A+B+C) | Re-embeds only `body_hash`-changed docs; server queries the pre-built store (fast startup). |
| Citations | **Code-built** (id, title, source_url, obsidian_link) from indexed metadata | Always-correct links; never LLM-generated. |
| Auth | **stdio trusted; HTTP token-gated** (bearer via env) | stdio runs as the user (local trust); a shared HTTP endpoint requires a token. Keys never exposed to clients. |
| search result fields | id, title, **summary**, tags, status, source_url, obsidian_link, snippet, score | B's summary makes 8-result scans far more useful than raw chunks; tags/status enable agent-side filtering (free — already indexed). |

### Prerequisites (already met)
- ✅ OpenAI key `ringkas-prd-embed`/`openai-api-key` (probe: 1536-dim).
- ✅ MiniMax key `ringkas-prd-enrich`/`llm-api-key`.
- ✅ Python 3.10 + Poetry. ✅ Vault populated nightly by A+B.

---

## 3. Architecture

Python package in `mcp/` inside `llm-wiki/`. Three layers: a retrieval **core** (no MCP knowledge), a **tool layer** (`server.py`), and a **transport** (stdio/HTTP launch flag).

```
mcp/
├─ pyproject.toml          Poetry: mcp (SDK), chromadb, httpx, pyyaml, pytest
└─ prd_mcp/
   ├─ config.py            vault path, keys (keychain), model ids, base URLs, chroma path,
   │                       top-k, http token. Validates on startup.
   ├─ keychain.py          read_secret(service, account) via `security` CLI.
   ├─ vault.py             read_doc(path)->Doc, list_docs(prds_dir). Parse frontmatter+body.
   ├─ chunk.py             chunk_doc(doc,size,overlap) -> body chunks + summary chunk. Pure.
   ├─ llm.py               embed(texts)->OpenAI vectors ; chat(messages)->MiniMax. Retry/timeout.
   ├─ store.py             Chroma wrapper: upsert/delete_by_doc/query/stored_hashes.
   ├─ retrieve.py          retrieve(query, store, embed_fn, k) -> distinct-PRD results.
   ├─ answer.py            build_prompt / format_citations / answer(q, retrieved, chat_fn).
   ├─ index.py             incremental indexer CLI (body_hash). The 4th nightly job.
   └─ server.py            MCP server: search_prds + ask_prds tools; stdio default, --http token-gated.
```

The core (vault → chunk → llm → store → retrieve → answer) is the C custom plan's design, finally built. `server.py` imports `retrieve`/`answer` and exposes them as tools. The Chroma store is at its OWN path (e.g. `mcp/.chroma`), never Open WebUI's collection.

---

## 4. Tool Contract

### `search_prds`
```
description: "Search Ringkas PRDs by topic or keyword. Returns the most relevant PRDs with
              their summary, link, and a snippet — for you to read and reason over. Use when
              you need to find or compare PRDs yourself."
input:  { query: string (required), k: integer (optional, default 8, max 20) }
output: {
  results: [ { id, title, summary, tags: [..], status, source_url,
               obsidian_link: "[[stem]]", snippet, score } ],
  count: N
}
```

### `ask_prds`
```
description: "Ask a question about Ringkas PRDs and get a grounded answer with citations.
              Uses ONLY the PRD content; if the PRDs don't cover it, says so. Use when you
              want a direct answer, not raw results."
input:  { question: string (required) }
output: {
  answer: string,
  sources: [ { id, title, source_url, obsidian_link } ],
  grounded: boolean   // false when no relevant PRD found
}
```

### Contract guarantees
- **Code-built citations** — `source_url`/`obsidian_link` come from indexed metadata (A's frontmatter), never the LLM.
- **`ask_prds` is grounded** — strictly from retrieved chunks; `grounded:false` + honest "no PRD covers this" when retrieval is empty.
- **Structured JSON** — both tools return machine-parseable objects so agents can program against them.
- **Keys never exposed** — clients call tools; the server holds the keychain creds.

---

## 5. Data Flow

```
search_prds:  query → llm.embed → store.query(top-k) → dedupe to distinct PRDs → structured results
ask_prds:     question → (same retrieve) → answer.build_prompt → llm.chat → {answer, citations, grounded}
index (nightly): vault → for each doc: body_hash changed vs stored? → chunk (body + summary) →
                 llm.embed → Chroma upsert (with metadata); doc gone from vault → delete its entries.
```

### What gets indexed (per PRD → multiple Chroma entries)
- 1 summary chunk (`llm.summary`) + N body chunks (~1000 chars, ~150 overlap).
- Metadata per entry: `{ id, stem, title, source_url, tags, status, chunk_type, body_hash }`.

### Prompt for `ask_prds` (anti-hallucination)
System: answer using ONLY the provided PRD context; cite the PRDs used; if the context doesn't answer, say so — don't invent. User: question + retrieved chunks labeled by `[EP-id · title]`.

---

## 6. Index & Refresh

- The MCP owns its Chroma store (separate path from Open WebUI's). `prd-mcp index` is incremental by `body_hash` (re-embed only changed docs; remove docs gone from the vault; re-embedding a changed doc replaces all its entries).
- Scheduled as a **4th launchd job ~12:20**, after the A (11:00) → B (11:45) → C (12:10) chain, so the MCP index reflects the freshest enrichment.
- The MCP server only *queries* the pre-built store → fast startup (important for stdio, which launches per session).

---

## 7. Error Handling

Principle (inherited from A/B/C): one bad doc never aborts indexing; never wipe good vectors on a transient failure; never hallucinate an answer; never crash the server on a tool error.

| Situation | Behavior |
|---|---|
| Index empty / missing | Tool returns a clear MCP error: "PRD index not built — run `prd-mcp index`." |
| `search_prds` no match | `{results: [], count: 0}` — empty, not an error. |
| `ask_prds` no match | `{answer: "No PRD covers this.", sources: [], grounded: false}` — honest, no hallucination. |
| Embed / LLM call fails | Bounded retry + wall-clock timeout; after cap → retryable MCP error. Server stays up. |
| Indexer: one bad doc | Log, skip, continue; its existing vectors untouched. Non-zero exit on errors. |
| HTTP transport: missing/bad token | 401 before any tool runs. |
| Keychain read fails | Server fails fast at startup naming the missing key/service. |

---

## 8. Testing Strategy

pytest. Pure logic unit-tested against fixtures; LLM + Chroma injected/faked; one manual end-to-end via a real MCP client.

| Layer | Approach |
|---|---|
| vault / chunk | Unit vs fixtures: frontmatter+body parse; summary-as-own-chunk; size/overlap; empty body. |
| retrieve | Fake embedder + temp Chroma: top-k ordering, dedupe to distinct PRDs. |
| answer | Fake LLM: citation block built from metadata (correct ids/urls/[[links]]); empty-context → honest non-answer. |
| index incremental | unchanged body_hash → skip; changed → re-embed (entries replaced); removed → deleted. |
| llm.py | Mocked-HTTP: embed + chat retry/timeout/JSON-shape parse. |
| server.py tools | Fake retrieval core: `search_prds` returns the right structured shape; `ask_prds` returns answer+sources+grounded; empty index → proper MCP error. |
| transport | Smoke: launch stdio, `list_tools` + one `search_prds`, assert response. |
| End-to-end | Manual: register in Claude Code, run `search_prds("referral")` + `ask_prds(...)`, verify real results + citations against the live index. |

No live LLM/embed calls in the automated suite.

---

## 9. Out of Scope

- Writing to the vault or Notion (read-only).
- A separate embedding/index from Open WebUI's — the MCP keeps its own; it does not share or reconcile with OWUI's collection.
- Metadata pre-filtering inside tools (agents filter the returned `tags`/`status` themselves); a `filter` arg can be added later.
- Multi-turn conversational memory in `ask_prds` (each call is independent).
- Tools that mutate PRDs or create new ones.

---

## 10. One-Time Setup (prerequisites met)

1. ✅ Keys in keychain: `ringkas-prd-embed`/`openai-api-key`, `ringkas-prd-enrich`/`llm-api-key`.
2. `cd mcp && poetry install`.
3. Build the index once: `VAULT_PATH=... poetry run prd-mcp index`.
4. Register in the client:
   - **Claude Code / Codex (stdio):** add an MCP server entry pointing at `poetry run prd-mcp serve` with `VAULT_PATH` in its env.
   - **HTTP (shared):** `poetry run prd-mcp serve --http`, set `MCP_AUTH_TOKEN` env; expose over Tailscale if sharing.
