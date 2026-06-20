# PRD MCP — Backlog: patterns to borrow from Atlas

**Date:** 2026-06-20
**Context:** The AI team maintains **Atlas** (`risa-nxt/atlas`, branch `develop`) — a
production-grade multi-tenant Markdown KB platform with hybrid search, LLM
reranking, an editor agent, version/audit trails, and MCP retrieval tools. After
reviewing it, we chose to **merge our self-contained PRD MCP as-is** (it ships PRD
value today via our Notion sync + own Chroma, with no Atlas infra dependency) and
adopt Atlas's best ideas incrementally. This file is that adoption list.

Our system and Atlas solve different halves: **we own ingestion** (Notion → vault →
enrich, nightly) which Atlas lacks (upload-only); **Atlas owns retrieval quality**.
The items below close our retrieval-quality gap without taking on Atlas's
infrastructure.

---

## High value

### 1. Cards select, bodies prove (two-layer retrieval)
**Atlas:** every unit has a 4-field *card* (`title`, `summary`, `use_when`,
`keywords`) used only to *decide whether to open the unit*, and a *body* that is the
only thing answered from. Search returns cards (cheap); bodies are read on demand.

**Ours today:** `ask_prds` retrieves chunks and synthesizes in one shot — conflates
"looks relevant" with "is the evidence."

**Adopt:** split `search_prds` (returns card-like metadata: id/title/summary/tags —
already close) from a `read_prd(id)` that returns the full body; let an agent triage
then read. Lower priority for `ask_prds` (it already grounds), higher value for the
agent-driven `search` path. B already generates a `summary`; a `use_when` + `keywords`
field on enrichment would mirror Atlas's card most directly.

### 2. Relevance verdict, not a raw score
**Atlas:** `search` returns a whole-result `relevance_verdict` ∈ `match` /
`no_match` / `degraded` (from an LLM grader), so consumers never reason from
look-alike fusion scores.

**Ours today:** we return `score = 1 - distance` — exactly the "look-alike score" the
Atlas kb-search skill warns against reasoning from.

**Adopt:** add a lightweight grader pass (or a distance threshold to start) that
labels the result set `match`/`no_match`, so `search_prds` can honestly say "the PRDs
have nothing for this" instead of returning weak hits with misleading scores.

### 3. Hybrid + keyword search (catch literal identifiers)
**Atlas:** fuses semantic + lexical (RRF, k=60) and exposes a separate
`keyword_search` for exact substrings — because embeddings structurally miss codes,
numbers, abbreviations (their words: "not a tuning gap, it's structural").

**Ours today:** pure vector search. A PRD corpus is *full* of literals — `EP-457`,
`SP3K`, `LTV`, `KPR Subsidi`, product names — that pure-embedding ranks poorly. Our
own SP3K smoke showed semantic returning adjacent-but-wrong notification PRDs.

**Adopt:** add a `keyword_search(query)` tool over the raw PRD bodies (Chroma
supports `where_document={"$contains": ...}`, or a simple grep-index). Biggest
single accuracy win for this corpus. Optionally fuse with semantic via RRF later.

---

## Medium value

### 4. wikilink sub-graph following
**Atlas:** bodies carry `[[wikilink]]` cross-references; the consumer skill follows
them for multi-hop questions. Our B already writes `llm.related` links and the vault
is Obsidian (`[[stem]]` native) — we have the graph, we just don't traverse it in
retrieval. Adopt: after reading a PRD, surface its `[[related]]` ids as next-hop
candidates.

### 5. Batch read with neighbors + dedup
**Atlas:** `read_units(ids, neighbors=n, already_read_ids=...)` — one call, adjacent
chunks, no re-reads. If we add `read_prd`, mirror the batch + dedup ergonomics.

### 6. Structured error envelope
**Atlas:** every 4xx/5xx shares `{error:{type,code,message,request_id}}`. If we ever
expose `--http` beyond Tailscale-local, adopt a stable machine-readable error shape.

---

## Explicitly NOT adopting (YAGNI for a single-user PRD tool)
- **Multi-tenancy** (tenant/project/user scoping, visibility predicates) — we have one
  corpus, one user.
- **Postgres/pgvector + async worker + agent runtime + Phobos MCP gateway + LiteLLM** —
  Atlas's whole infra stack. Our Chroma + stdio server is right-sized.
- **Version archive / audit log / diff endpoints** — the vault is git-adjacent and
  Notion is the system of record; we don't need our own version store.
- **Operator React UI** — agents are our only consumers.

---

## If priorities change: the "feed Atlas" pivot
The one structural alternative we deferred: use our A+B (Notion→vault→enrich) as the
ingestion front-end that uploads PRDs into Atlas via `POST /api/v1/upload`, then retire
our Chroma/MCP for Atlas's retrieval. Needs Atlas deployed to a reachable endpoint
(today it's `127.0.0.1` local-dev) + AI-team coordination on tenancy. Revisit if the
AI team wants PRDs to live in Atlas, or if maintaining our own retrieval becomes a
burden.
