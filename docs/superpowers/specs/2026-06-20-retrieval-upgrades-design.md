# Retrieval Upgrades (v2 Phase 1) — Design

**Date:** 2026-06-20
**Status:** Design approved, pending implementation plan
**Scope:** Three agent-facing retrieval improvements to the shared `mcp/prd_mcp` core, borrowed
from the AI team's Atlas KB platform. Pure backend — improves Claude Code / Codex today and is
inherited by every later v2 surface (the dashboard's Search/Ask tabs).
**Roadmap:** Phase 1 of `2026-06-20-llm-wiki-v2-roadmap.md` (Retrieval → Auth → Dashboard).

---

## 1. Context

v1 shipped `search_prds` (ranked results with `score = 1 - distance`) and `ask_prds` (grounded
answer). Two structural weaknesses, both confirmed empirically against the live 287-PRD index
(7,810 chunks, 7.6 MB):

- **Pure vector search misses literal identifiers.** Embeddings carry little signal for codes,
  numbers, and abbreviations (`EP-457`, `SP3K`, `LTV`, `KPR`). The SP3K smoke returned
  adjacent-but-wrong notification PRDs.
- **A raw score is not a relevance signal.** A 0.13-vs-0.06 score looks meaningful but an agent
  can't branch on it. Atlas's kb-search skill is explicit: don't reason from look-alike scores.

This phase adds the three Atlas patterns that close those gaps, scaled to a single-corpus tool
(no multi-tenancy, no separate FTS store, no LLM reranker — see YAGNI notes).

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| keyword_search backend | **Chroma `where_document={"$contains": q}`** | Reuses the index we already build nightly; **measured 1–3 ms/query vs ~20 ms for a from-scratch Python scan** on the real corpus. A separate SQLite-FTS index would match the speed but add a second store to populate + sync, for ranking/stemming we don't need at 287 docs. |
| Relevance signal | **Whole-result `verdict`: `match` / `no_match` / `degraded`** | Agents branch on the verdict, never the score. Measured separation is clean: in-domain queries score positive (~0.28–0.45), out-of-domain junk negative (~−0.5 to −0.6). |
| Verdict mechanism | **Score threshold (default ~0.05), NOT an LLM grader** | Threshold already separates cleanly on real data — fast, free, deterministic. `degraded` stays in the enum so an optional LLM grader can be added later without a contract change. |
| read_prd source | **The vault file via existing `vault.read_doc()`**, not index chunks | Index body chunks carry 150-char overlap; joining them double-counts overlap regions. The vault is the canonical, exact body. Search uses the index; read uses the source. |
| read_prd shape | **Single `read_prd(id)`**, no batch/neighbors/dedup | Atlas's `read_units(ids[], neighbors, already_read_ids)` is YAGNI at 287 docs / ~30 KB bodies. Contract leaves room for a batch variant later. |
| Contract compatibility | **Additive** | `search_prds` keeps every existing field and *adds* `verdict`; existing callers don't break. |

### Measured grounding (real index, 2026-06-20)
- keyword_search latency: `$contains` 1.1–3.1 ms vs python full-scan 18–27 ms (≈8–20× faster; both
  trivially fast — the deciding factor is simplicity, not speed).
- verdict separation (top score): referral 0.451, bank-report-dashboard 0.277, SP3K −0.248,
  weather −0.541, python-debug −0.497, pizza −0.575. A threshold near 0 splits good from junk;
  SP3K correctly lands below it (no PRD covers it).
- read_prd: `EP-437` → 34 index chunks (1 summary + 33 overlapping body) vs one clean vault file.

## 3. Architecture

Extends the existing MCP-agnostic core. The core never imports MCP; `server.py` wraps it (this is
what lets Phase 3's web-API reuse the same functions).

```
mcp/prd_mcp/
  config.py    + score_threshold: float = 0.05  (env PRD_SCORE_THRESHOLD)
  store.py     + keyword_query(query, k) -> rows   (Chroma $contains; includes documents+metadata)
  retrieve.py  ~ retrieve(...) -> (results, verdict)        (threshold over best score)
               + keyword_retrieve(query, store, k) -> distinct-PRD hits with match snippet
  read.py      NEW  read_prd(prd_id, read_doc_fn, list_docs_fn) -> dict   (full body from vault)
  answer.py    ~ answer(...) short-circuits when verdict == no_match: honest non-answer, NO chat_fn
  server.py    + keyword_search tool, + read_prd tool; search_prds gains `verdict`
```

### Snippet construction (keyword_search)
A window of body text around the first case-insensitive match (e.g. ±120 chars), so the agent
triages from the snippet without reading the whole body — and the `k`-cap (insertion-order in
Chroma) is not a silent quality cliff. Results dedupe to distinct PRDs.

## 4. Tool Contracts

### `keyword_search`
```
description: "Exact-substring search over PRD bodies for literal identifiers — codes, numbers,
              product names, abbreviations (e.g. EP-457, SP3K, KPR, LTV) that semantic search
              ranks poorly. Returns matching PRDs with a snippet around each hit. Pair with
              search_prds for concept queries; union both for mixed queries."
input:  { query: string (required), k: integer (optional, default 10, max 20) }
output: { results: [ { id, title, status, tags, source_url, obsidian_link, snippet } ], count: N }
```

### `read_prd`
```
description: "Read the full canonical body of ONE PRD by id (e.g. 'EP-437'). Use after search_prds
              / keyword_search to read the evidence for the PRDs that look relevant — search
              returns selection signals (summary/snippet); read_prd returns the body you answer
              from."
input:  { id: string (required) }
output: { found: boolean, id, title, status, tags, source_url, obsidian_link, body }
        // found:false (with empty body) when no PRD has that id — never an error.
```

### `search_prds` (additive change)
```
output: { results: [ { ...existing fields..., score } ], count: N,
          verdict: "match" | "no_match" | "degraded" }
// match    — at least one result's score >= score_threshold; results are real.
// no_match — every result below threshold; results: [] (the honest "KB has nothing" signal).
// degraded — reserved: an enabled LLM grader was unavailable (not used in Phase 1).
```

### `ask_prds` (behavioral change)
Uses the same retrieve+verdict. On `no_match` → returns the honest non-answer
(`grounded:false`, `sources:[]`) **without calling the LLM**. On `match` → unchanged grounded flow.

### Guarantees (unchanged from v1)
Code-built citations from metadata; `ask_prds` answers only from retrieved context; keys never
exposed to clients; one bad doc never aborts; a tool error never crashes the server.

## 5. Data Flow

```
keyword_search:  query -> store.keyword_query($contains, k) -> dedupe distinct PRDs + snippet -> results
search_prds:     query -> embed -> store.query -> retrieve(): best score vs threshold -> (results, verdict)
ask_prds:        same retrieve -> verdict==no_match ? honest no-answer (no LLM) : build_prompt -> chat
read_prd:        id -> resolve to vault path -> vault.read_doc() -> { found, body, metadata }
```

## 6. Error Handling

| Situation | Behavior |
|---|---|
| keyword_search no match | `{results: [], count: 0}` — empty, not an error |
| read_prd unknown id | `{found: false, body: "", ...}` — honest; server stays up |
| search_prds all below threshold | `verdict: "no_match"`, `results: []` |
| ask_prds on no_match | honest "no PRD covers this", `grounded:false`, **no LLM call** |
| Index empty / missing | existing clear MCP error ("index not built — run `prd-mcp index`") |
| Embed / LLM failure | existing bounded retry + wall-clock timeout |

## 7. Testing Strategy

pytest, TDD, fakes injected — mirrors the existing suite; no live LLM/embed/Chroma calls in the
automated tests.

| Layer | Tests |
|---|---|
| store | `keyword_query` finds a known literal; respects `k`; returns distinct stems; row includes document text for the snippet. |
| retrieve | verdict `match` when a fake hit ≥ threshold, `no_match` when all below; `keyword_retrieve` dedupes to distinct PRDs and builds a snippet around the match. |
| read | `read_prd` returns the full body + metadata for a fixture doc; `found:false` for an unknown id. |
| answer | `no_match` verdict → honest non-answer and the fake `chat_fn` is **not** called; `match` → normal grounded flow. |
| server | `keyword_search` and `read_prd` return the documented shapes; `search_prds` output includes `verdict`. Fakes for store/llm. |

## 8. Out of Scope (YAGNI / deferred)

- A separate FTS index (SQLite FTS5 / inverted index) — `$contains` is fast enough and reuses the
  existing store. Revisit only if keyword **ranking** quality becomes a real need.
- An LLM relevance grader (Atlas runs one per search) — threshold suffices on this corpus; the
  `degraded` enum reserves the seam.
- Batch / neighbors / already-read dedup for reads — single `read_prd` is enough at this scale.
- RRF fusion of the keyword + semantic lanes inside the tools — agents union the two lanes
  themselves (Atlas's documented pattern); a fused tool can be added later.
- Any UI — that is Phase 3.
