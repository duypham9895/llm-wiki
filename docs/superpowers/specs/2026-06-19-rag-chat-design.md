# RAG Chat (Sub-project C)

**Date:** 2026-06-19
**Status:** Design approved, pending implementation plan
**Scope:** Sub-project C of the `llm-wiki-prd` initiative. A chat layer that answers questions over the enriched PRD corpus produced by A + B.

---

## 1. Context & Position in the Initiative

| # | Sub-project | What it does | Status |
|---|---|---|---|
| **A** | Notion → Obsidian sync | Syncs PRDs from the Product Backlog DB into the vault as clean Markdown. | **Done & merged.** |
| **B** | LLM enrichment | Fills each PRD's `llm:` block with a summary, tags, related backlinks. | **Done & merged.** |
| **C** | **RAG chat** | A Chainlit web chat that answers questions over the corpus with citations to source PRDs. | **This spec.** |

**C is a read-only consumer of the vault.** It does not import A or B and does not modify any `.md` file. The **filesystem (the vault) is the only coupling** — C reads the Markdown that A wrote and B enriched. C is the first **Python** sub-project (A and B are Node/TypeScript); it reuses the user's prior Python RAG patterns (`chainlit` + `chromadb`, as in `llm-pdf-qa-workshop`), not A/B's TypeScript code.

**What C inherits from A + B (an unusually pre-digested corpus):**
- Clean GFM markdown bodies (A).
- A per-doc `llm.summary` — a high-signal embedding target (B).
- `llm.tags`, `llm.related` — metadata + a knowledge graph (B).
- `sync.source_url`, `sync.title`, the local filename stem — built-in citation provenance (A).
- `llm.body_hash` — a content hash that drives incremental indexing for free (B).

Corpus size: ~132 PRDs, bodies 1.4 KB – 175 KB.

---

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Interface | **Chainlit web chat** | Browser Q&A with citations; matches the user's prior `chainlit-qna-ringkas` / `llm-pdf-qa-workshop` projects. |
| Language/stack | **Python** (Chainlit + ChromaDB) | C's stack; the vault is the language-neutral seam with A/B. |
| Embedding source | **OpenAI `text-embedding-3-small`, called directly** (1536-dim) | **Revised 2026-06-19 after the day-one probe:** the MiniMax router exposes 32 models, ALL chat/generation — none embed (`/v1/embeddings` errors `No credentials for provider: openai`). So embeddings use OpenAI directly (key in keychain `ringkas-prd-embed`/`openai-api-key`), while chat/answers stay on the MiniMax router. Probe-verified: returns 1536-dim vectors, ~6 tokens/short-string. Isolated behind `llm.py` (two credentials: OpenAI for embed, MiniMax for chat). |
| Vector store | **ChromaDB** (local, persistent) | Used in the user's prior project; on-disk persistence + metadata filtering; ideal for 132 docs, zero infra. |
| What to embed | **Body chunks + the B summary**, per doc | Chunks catch detail; the summary catches gist. Both carry full metadata. |
| Retrieval (v1) | **Pure vector top-k** (default k=8), dedupe to distinct PRDs | YAGNI: vector search alone handles most questions at this scale. Metadata IS stored, so adding tag/status pre-filtering later needs no re-index. |
| Answer LLM | **Same MiniMax endpoint** (`minimax/MiniMax-M3`) | One provider for embeddings + chat + answers; proven working in B. |
| Citations | **Title + Notion `source_url` + `[[Obsidian stem]]`**, built by code from metadata | Maximally traceable; deterministic links (never LLM-generated → never hallucinated). |
| Indexing | **Separate incremental indexer** (`python -m chat.index`) | Re-embeds only docs whose `body_hash` changed; chained after the A+B nightly pipeline. The chat app only queries the pre-built store (fast startup). |

### Resolved by the day-one probe (no longer open)
1. ✅ MiniMax router has **no embedding model** (32 models, all chat) → embeddings use **OpenAI `text-embedding-3-small`** directly (1536-dim, probe-verified).
2. ✅ Two credentials: OpenAI key (`ringkas-prd-embed`/`openai-api-key`) for embeddings; MiniMax key (`ringkas-prd-enrich`/`llm-api-key`) for chat answers. Both keychain-stored and verified.

---

## 3. Architecture

Python sub-project in `chat/` inside `llm-wiki/`. Two runnable pieces: an offline **indexer** and the **Chainlit app**. They are fully decoupled — the indexer writes Chroma, the app only reads it.

```
chat/
├─ config.py     Settings: vault path, LLM base URL + key (keychain), embedding
│                model id, chat model id, Chroma path, chunk size/overlap, top-k.
│                Validates on startup.
├─ llm.py        Swappable OpenAI-compatible client: embed(texts)→vectors AND
│                chat(messages)→answer. Isolates the MiniMax endpoint. Retry/timeout.
├─ vault.py      Reads PRD .md: parse frontmatter (sync.* + llm.* + body_hash),
│                extract title/source_url/stem/tags/status/body.
├─ chunk.py      Splits a body into overlapping chunks; emits the B summary as its
│                own chunk. Pure.
├─ index.py      Indexer CLI: re-embed+upsert changed docs (by body_hash) into
│                Chroma with metadata; remove deleted docs. Incremental. Summary + exit code.
├─ retrieve.py   embed(question) → Chroma top-k → dedupe to distinct PRDs → chunks + metadata.
├─ answer.py     Build prompt from retrieved chunks → llm.chat → answer + deterministic
│                citation block. (llm injected.)
└─ app.py        Chainlit entrypoint: message → retrieve → answer → stream with citations. Thin glue.
```

### Reuse / isolation
- `llm.py` isolates the one external unknown (embeddings endpoint shape), exactly as B's `llm-client` isolated the chat endpoint. The API key is read from the macOS keychain (the A/B pattern).
- The chunking, retrieval, citation-formatting logic is pure and unit-tested; the LLM and Chroma are injected for tests.

---

## 4. Data Flow

### Indexing (offline, incremental)
```
vault .md files → vault.read → for each doc:
   body_hash changed vs Chroma's stored hash?
     ├─ no  → skip
     └─ yes → chunk (body chunks + summary) → llm.embed → Chroma upsert (with metadata)
   docs in Chroma but gone from vault → delete
→ print: indexed N · skipped M · removed K · errors E   (non-zero exit on errors)
```

### Chat (online, per question)
```
user question → llm.embed(question) → Chroma query (top-k, k=8)
   → dedupe to distinct PRDs, best chunks per PRD
   → answer.build_prompt → llm.chat
   → stream answer + citations to Chainlit
```

### What gets indexed (per PRD → multiple Chroma entries)
- 1 **summary** chunk = `llm.summary`.
- N **body** chunks = body split ~1000 chars, ~150 overlap.
- Each entry's metadata: `{ id, stem, title, source_url, tags, status, platform, chunk_type, body_hash }`.

### Prompt to the answer LLM
```
System: You answer questions about Ringkas PRDs using ONLY the provided context.
        Cite the PRDs you used. If the context doesn't answer the question, say so —
        do not invent. Be concise and direct.
User:   Question: <question>
        Context:
        [EP-468 · Bank Report on CRM] <chunk text>
        [EP-471 · Referral Template] <chunk text>
        ...
```
Grounding strictly in context + "admit when unknown" is the core anti-hallucination guard.

### Citation block (appended to every answer, built by code)
```
Sources:
- Bank Report on CRM for Bank Users — [Notion](https://notion.so/...) · [[EP-468-bank-report-on-crm-for-bank-users]]
- Update Referral Share Pretext Template — [Notion](https://notion.so/...) · [[EP-471-update-referral-share-pretext-template]]
```
Assembled deterministically from the retrieved chunks' metadata (which came from A's frontmatter). The LLM may reference PRDs by ID in its prose, but the clickable links are code-generated → always correct, never hallucinated. Only PRDs the answer drew from are listed.

---

## 5. Incremental Indexing

- Chroma stores each doc's `body_hash` as entry metadata. On index, compare current (from the vault's `llm.body_hash`) vs stored; re-embed only changed docs. Unchanged → skip.
- A doc present in Chroma but absent from the vault → its entries are removed.
- Re-embedding a changed doc replaces all its entries (delete old by `id`, upsert new) so stale chunks never linger.
- Chained after the A+B nightly pipeline (A ~03:17, B ~04:23, index ~04:50), or run on demand. The chat app reads the pre-built store.

---

## 6. Error Handling

Principle (inherited from A/B): **one bad doc never aborts indexing; never wipe good data on a transient failure; never hallucinate an answer.**

| Failure | Behavior |
|---|---|
| A doc fails to parse / chunk / embed | Log, skip that doc, continue. Its existing Chroma entries are left intact (not removed on failure). Counts as an error. |
| Embedding call fails / times out | `llm.embed` retries with bounded backoff + wall-clock timeout; after cap, skip that doc this run. |
| Empty / missing Chroma index (chat) | Friendly message: "No index yet — run `python -m chat.index` first." |
| Retrieval returns nothing relevant | The LLM is still called but told context is thin → answers "I don't have a PRD covering that" rather than inventing. |
| Answer LLM call fails / times out | Chainlit shows a clear error; the session does not crash; user can retry. |

**Indexer summary line:** `indexed N · skipped M · removed K · errors E`, non-zero exit on errors (so a chained scheduler surfaces it).

---

## 7. Testing Strategy

pytest (the user's prior RAG-project test stack). Pure logic unit-tested against fixtures; LLM + Chroma injected/faked; one live smoke run.

| Layer | Approach |
|---|---|
| `chunk.py` | Unit: body → expected chunks (size/overlap); summary emitted as its own chunk; tiny body = 1 chunk; empty body handled. |
| `vault.py` | Unit vs fixture `.md`: parses sync/llm/body_hash/title/source_url/tags/status; handles a doc with an empty `llm` block. |
| `retrieve.py` | Unit with a **fake embedder + in-memory/temp Chroma**: known vectors → asserts top-k ordering and dedupe-to-distinct-PRDs. |
| `answer.py` | Unit with a **fake LLM**: retrieved chunks → asserts the citation block is built correctly from metadata (titles/URLs/`[[links]]`), cites only retrieved PRDs, and the "no context" path yields an honest non-answer. |
| `index.py` incremental | Unit: unchanged `body_hash` → skip; changed → re-embed (old entries replaced); removed doc → deleted. Fake embedder + temp Chroma dir. |
| `llm.py` | **Mocked-HTTP**: embed + chat retry/timeout/JSON-shape parsing. A test asserting the embeddings response shape parses. No live calls in CI. |
| End-to-end | **One manual smoke run**: an early **embeddings probe** (one call to `/v1/embeddings`) BEFORE building the indexer to confirm the endpoint shape; then index the real vault and ask an EP-468-style question, verifying a grounded answer with correct, clickable citations. Needs the live endpoint. |

No live LLM/embedding calls in the automated suite — the live MiniMax behavior (does `/v1/embeddings` exist? what shape? latency over 132 docs?) is validated only by the probe + smoke run, the same way A's and B's live runs caught what unit tests could not.

---

## 8. Out of Scope (sub-project C)

- Metadata pre-filtering (parse "in-progress CRM PRDs" → tag/status filter). Metadata is stored in Chroma; filtering is a later refinement needing no re-index.
- Conversation memory / multi-turn follow-ups beyond Chainlit's defaults (v1 answers each question against the corpus; richer threading is later).
- Re-ranking models, query rewriting, hypothetical-document expansion.
- Any write to the vault or to Notion. C is strictly read-only over the vault.
- Auth / multi-user / deployment beyond local use.

---

## 9. One-Time Setup (prerequisite for implementation)

1. ✅ Done: probe confirmed the router has no embedding model; embeddings use OpenAI `text-embedding-3-small` directly. Store the OpenAI key: `security add-generic-password -s ringkas-prd-embed -a openai-api-key -w 'sk-...'` (done & verified).
2. The MiniMax chat key is already in the keychain (`ringkas-prd-enrich` / `llm-api-key`, shared with B). C reads TWO keys: OpenAI (embeddings) + MiniMax (chat).
3. Python env (Poetry, as in the prior project) with `chainlit`, `chromadb`, an HTTP client, `pytest`.
4. Capture vault path + base URL + model ids + Chroma path into `config.py` settings.
