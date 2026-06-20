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
| keyword_search backend | **Chroma `where_document={"$contains": term}`** over an **index-time lowercased search field** | Reuses the index we already build nightly; **measured 1–3 ms/query**. A separate SQLite-FTS index would match the speed but add a second store to sync, for ranking/stemming we don't need at 287 docs. Case-insensitivity must be solved at index time (see Edge 1) — a query-time lowercase scan measured 165–580 ms and grows with the corpus. |
| Case handling | **Add one synthetic "keyword chunk" PER PRD whose DOCUMENT text = `lower(body + title + id + tags)`; match `lower(query)` via `where_document $contains`** | `$contains` is case-sensitive (`SP3K`→37, `sp3k`→3, `Sp3k`→0) AND **only works on document text, never metadata** (Chroma rejects `$contains` in a `where` metadata clause — verified). So the lowercased search field must BE a chunk's document, not a metadata tag. One keyword chunk per PRD, found via `where={chunk_type:"keyword"}` + `where_document`. **Measured 1.6–4.6 ms at 287 docs**; case-insensitive; covers id/title/tags. Requires extending the indexer + a one-time reindex. |
| Keyword chunk vs semantic search | **Every vector query (`search_prds`/`ask_prds`) MUST filter `where={chunk_type:{"$ne":"keyword"}}`** | The keyword chunk carries a placeholder vector; without the filter it would surface as garbage in semantic results. Invariant + test. |
| Multi-word keyword queries | **AND-of-words via `where_document={"$and":[{"$contains":w}, ...]}`** (verified), dropping tokens <2 chars | `$contains` on a raw phrase fails across chunk boundaries (`"bank report dashboard"`→0). Split + AND the words. Tokens of 1 char (`"a"`,`"of"`) match almost everything → drop them; if all tokens drop, return empty. |
| Relevance signal | **Whole-result `verdict`: `match` / `no_match` / `degraded`** | Agents branch on the verdict, never the score. |
| Verdict mechanism | **Score threshold (default ≈ −0.15), NOT an LLM grader** | Threshold separates real junk (weather/pizza/python all ≤ −0.5) from in-domain queries. **Tuned from measured data, NOT ~0.05**: legit PM queries land low (`login` −0.06, `API` −0.20, `user permissions` +0.07), so a 0.05 cutoff would wrongly reject them. ≈ −0.15 keeps borderline-but-real queries as `match` while still rejecting clear out-of-domain junk. Re-tuned against a labeled set in the plan; `degraded` reserves the seam for an optional LLM grader later. |
| read_prd source | **The vault file via existing `vault.read_doc()`**, not index chunks | Index body chunks carry 150-char overlap; joining them double-counts overlap regions. The vault is the canonical, exact body. Search uses the index; read uses the source. |
| read_prd id resolution | **Exact match on `sync.id`** (read each doc's frontmatter id), not filename-stem prefix | Today 287/287 ids are unique with zero prefix-collisions and every stem starts with its id, so a prefix scheme works *now* — but matching the exact `id` field future-proofs against `EP-43` vs `EP-437`. |
| read_prd shape | **Single `read_prd(id)`**, no batch/neighbors/dedup | Atlas's `read_units(ids[], neighbors, already_read_ids)` is YAGNI at 287 docs / ~30 KB bodies. Contract leaves room for a batch variant later. |
| Degenerate queries | **Empty/whitespace query → `no_match` (search) / empty (keyword) WITHOUT an embed or store call** | `retrieve("")` currently embeds the empty string and returns a junk "result". Guard at the top of both retrieve paths. |
| Contract compatibility | **Additive** | `search_prds` keeps every existing field and *adds* `verdict`; existing callers don't break. |

### Measured grounding (real index, 2026-06-20; 287 PRDs, 7,810 chunks, 7.6 MB)
- **keyword_search latency:** `$contains` 1.1–3.1 ms vs a query-time case-insensitive full-scan
  165–580 ms (the latter grows with the corpus — hence the index-time search field).
- **case-sensitivity:** `SP3K`→37 chunks, `sp3k`→3, `Sp3k`→0 (Edge 1 — the headline risk).
- **multi-word:** `"SP3K notification"`→0, `"bank report dashboard"`→0 as raw substrings (Edge 3).
- **verdict separation (top score):** referral 0.451, bank-report-dashboard 0.277, SP3K −0.248;
  out-of-domain junk weather −0.541, python-debug −0.497, pizza −0.575; **borderline in-domain**
  login −0.06, API −0.20, user-permissions +0.07 (why the threshold is ≈ −0.15, not 0.05).
- **read_prd:** `EP-437` → 34 index chunks (1 summary + 33 overlapping body) vs one clean vault
  file; 287/287 ids unique, 0 prefix-collisions, 0 stems mismatching their id.
- **enrichment gaps:** 4/287 docs have no `llm.summary`/`body_hash` (B stragglers; recurs) — search
  must degrade gracefully and read_prd must still return the body.

## 3. Architecture

Extends the existing MCP-agnostic core. The core never imports MCP; `server.py` wraps it (this is
what lets Phase 3's web-API reuse the same functions).

```
mcp/prd_mcp/
  config.py    + score_threshold: float = -0.15  (env PRD_SCORE_THRESHOLD)
  chunk.py     + build_keyword_chunk(doc) -> Chunk(chunk_type="keyword",
               |   text=lower(body + " " + title + " " + id + " " + tags))  ONE per PRD
  store.py     + keyword_query(terms: list[str], k) -> rows
               |   where={chunk_type:"keyword"} + where_document={$and:[{$contains:w}...]}
               ~ query(...) adds where={chunk_type:{$ne:"keyword"}}  (exclude keyword chunk from
               |   semantic results — REQUIRED invariant)
  index.py     ~ each doc now also emits its keyword chunk; a one-time forced full reindex
               |   populates keyword chunks for existing docs (body_hash skip-guard → forced)
  retrieve.py  ~ retrieve(...) -> (results, verdict)   (threshold over best score; empty-query guard)
               + keyword_retrieve(query, store, k) -> distinct-PRD hits with snippet
               |   (lower+split query, drop <2-char tokens, AND-match; snippet from vault/original text)
  read.py      NEW  read_prd(prd_id, read_doc_fn, list_docs_fn) -> dict   (full body from vault,
               |   resolved by exact sync.id; found:false on miss)
  answer.py    ~ answer(...) short-circuits when verdict == no_match: honest non-answer, NO chat_fn
  server.py    + keyword_search tool, + read_prd tool; search_prds gains `verdict`
```

### Snippet construction (keyword_search)
The keyword chunk's own text is lowercased (useless for display), so the snippet is built from
**original-case text**: take the matched PRD's `summary` (already in metadata, real case) when it
contains the first matched word, else read the PRD body via the vault and cut a ±120-char window
around the first match, else fall back to the `summary` (or title) as-is. The agent triages from a
readable snippet without reading the whole body — and the `k`-cap (insertion-order in Chroma) is
not a silent quality cliff. Results dedupe to distinct PRDs.

## 4. Tool Contracts

### `keyword_search`
```
description: "Case-insensitive keyword search over PRD body, title, id, and tags — for literal
              identifiers (codes, numbers, product names, abbreviations: EP-457, SP3K, KPR, LTV)
              that semantic search ranks poorly. Multi-word queries match documents containing ALL
              the words (any order). Returns matching PRDs with a snippet. Pair with search_prds
              for concept queries; union both for mixed queries."
input:  { query: string (required), k: integer (optional, default 10, max 20) }
output: { results: [ { id, title, status, tags, source_url, obsidian_link, snippet } ], count: N }
// Case-insensitive (matches an index-time lowercased search field). Multi-word = AND-of-words.
// Empty/whitespace query -> { results: [], count: 0 } without touching the store.
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
keyword_search:  query -> (empty? -> []) -> lower+split, drop <2-char tokens -> (none left? -> [])
                 -> store.keyword_query(words): where chunk_type=keyword + where_document $and $contains
                 -> dedupe distinct PRDs + original-case snippet -> results
search_prds:     query -> (empty? -> no_match) -> embed -> store.query (WHERE chunk_type != keyword)
                 -> retrieve(): best score vs threshold -> (results, verdict)
ask_prds:        same retrieve -> verdict==no_match ? honest no-answer (no LLM) : build_prompt -> chat
read_prd:        id -> resolve by exact sync.id -> vault.read_doc() -> { found, body, metadata }
index (one-time): forced full reindex re-embeds every doc AND emits one keyword chunk per doc;
                 thereafter nightly incremental-by-body_hash as before.
```

## 6. Error Handling

| Situation | Behavior |
|---|---|
| keyword_search no match | `{results: [], count: 0}` — empty, not an error |
| keyword_search / search_prds empty or whitespace query | `{results: [], count: 0}` / `verdict: "no_match"` — guarded BEFORE any embed or store call |
| keyword_search query is all short/stopword tokens (<2 chars) | `{results: [], count: 0}` — tokens dropped, nothing left to AND |
| keyword chunk leaking into semantic search | prevented: every vector query filters `chunk_type != keyword` (invariant + test) |
| read_prd unknown id | `{found: false, body: "", ...}` — honest; server stays up |
| read_prd on an un-enriched doc (no summary) | still returns the full `body`; `summary`/`tags` may be empty — not an error |
| search_prds all below threshold | `verdict: "no_match"`, `results: []` |
| search_prds over un-enriched docs | empty `summary` field, never a crash (missing metadata defaults to `""`) |
| ask_prds on no_match | honest "no PRD covers this", `grounded:false`, **no LLM call** |
| Index missing keyword chunks (pre-reindex) | keyword_search returns empty until the one-time forced reindex populates them; the reindex is a required Phase 1 step, not optional |
| Index empty / missing | existing clear MCP error ("index not built — run `prd-mcp index`") |
| Embed / LLM failure | existing bounded retry + wall-clock timeout |

## 7. Testing Strategy

pytest, TDD, fakes injected — mirrors the existing suite; no live LLM/embed/Chroma calls in the
automated tests.

| Layer | Tests |
|---|---|
| chunk | `build_keyword_chunk` emits ONE `chunk_type="keyword"` chunk whose text = lower(body + title + id + tags); an un-enriched doc (no summary) still produces its keyword chunk from the body. |
| store | `keyword_query` matches the keyword chunk via `where_document`; **case-insensitive** (`"sp3k"` finds an `SP3K` doc); **AND-of-words** (`["bank","dashboard"]` needs both, any order); matches an id/title NOT in body text; respects `k`; distinct stems. **`query()` (semantic) EXCLUDES `chunk_type="keyword"`** (a keyword chunk with a near vector is never returned). |
| retrieve | verdict `match` when a fake hit ≥ threshold, `no_match` when all below; **empty/whitespace query → `no_match` with NO embed call** (assert embed_fn not called); `keyword_retrieve` lowercases + splits, **drops <2-char tokens** (all-short query → empty), dedupes to distinct PRDs, snippet drawn from original-case summary/body (never the lowercased keyword chunk). |
| read | `read_prd` returns the full body + metadata for a fixture doc resolved by exact `sync.id`; `found:false` for an unknown id; an **un-enriched** fixture (no summary) still returns its `body`; two ids where one is a prefix of the other resolve to distinct docs (no prefix-collision). |
| answer | `no_match` verdict → honest non-answer and the fake `chat_fn` is **not** called; `match` → normal grounded flow. |
| server | `keyword_search` and `read_prd` return the documented shapes; empty query → empty results without a store call; `search_prds` output includes `verdict`. Fakes for store/llm. |

## 8. Edge Cases (probed against the live index 2026-06-20; all covered above)

| # | Edge case | Risk | Handling |
|---|---|---|---|
| 1 | `$contains` is **case-sensitive** (`SP3K`→37, `sp3k`→3, `Sp3k`→0) | **High** — PMs type lowercase | Index-time lowercased `search_text`; match `lower(query)` against it |
| 2 | Canonical **id lives in metadata**, not body text | Medium — `keyword_search("EP-501")` could miss the real EP-501 | `search_text` includes id + title + tags, so identifiers are matched |
| 3 | **Multi-word** phrases split across chunks (`"bank report dashboard"`→0) | Medium — silent empty results | AND-of-words token matching, not raw-phrase substring |
| 4 | **Threshold ~0.05 too aggressive** (`login` −0.06, `API` −0.20 are real) | Medium — wrongly rejects valid queries | Threshold ≈ −0.15, re-tuned against a labeled set; junk still ≤ −0.5 |
| 5 | **Un-enriched docs** (4/287, recurs) have no summary/body_hash | Low — empty summary | Search degrades to empty summary; read_prd returns body regardless |
| 6 | **Empty/whitespace query** currently embeds "" and returns junk | Low — misleading result | Guard before embed/store: `no_match` / empty |
| 7 | `read_prd` **id resolution** by stem-prefix could collide (`EP-43` vs `EP-437`) | Low (0 collisions today) | Resolve by exact `sync.id` field |
| 8 | **Removed-from-Notion** docs | None today (A deletes them) | read_prd/search see only the vault; removed docs are gone by design — documented, no code |
| 9 | **`$contains` works ONLY on document text, not metadata** (Chroma rejects `$contains` in a `where` clause — verified) | **High** — would break the original "search_text in metadata" design | Lowercased search field is a **keyword chunk's document**, not metadata |
| 10 | The keyword chunk has a **placeholder vector** | **High** — would pollute every semantic result with garbage | Every vector `store.query` filters `where chunk_type != keyword`; explicit invariant + test |
| 11 | **Short/stopword tokens** (`"a"`, `"of"`) match almost everything | Medium — noise in AND-of-words | Drop tokens <2 chars; if none remain, return empty |
| 12 | Largest PRD keyword chunk ≈ **500 KB** of lowercased text | Low — storage/scan cost | Acceptable (Chroma handles it; scan stays ms-fast); note for future capping |
| 13 | **Special chars in query** (`c++`, `(test)`, `don't`, unicode) | None — verified | `$contains` is literal substring, NOT regex; passes through safely, no sanitization needed |

**Scope note:** Edges 1–2 and 9–10 make the indexer + a **one-time forced reindex** part of Phase 1
(not just new tools): every PRD gets a synthetic lowercased keyword chunk, and all 287 existing
docs must be reindexed to populate them.

## 9. Out of Scope (YAGNI / deferred)

- A separate FTS index (SQLite FTS5 / inverted index) — `$contains` is fast enough and reuses the
  existing store. Revisit only if keyword **ranking** quality becomes a real need.
- An LLM relevance grader (Atlas runs one per search) — threshold suffices on this corpus; the
  `degraded` enum reserves the seam.
- Batch / neighbors / already-read dedup for reads — single `read_prd` is enough at this scale.
- RRF fusion of the keyword + semantic lanes inside the tools — agents union the two lanes
  themselves (Atlas's documented pattern); a fused tool can be added later.
- Any UI — that is Phase 3.
