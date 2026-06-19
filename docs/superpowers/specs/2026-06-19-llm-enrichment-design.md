# LLM Enrichment (Sub-project B)

**Date:** 2026-06-19
**Status:** Design approved, pending implementation plan
**Scope:** Sub-project B of the `llm-wiki-prd` initiative. Consumes the Markdown corpus produced by sub-project A.

---

## 1. Context & Position in the Initiative

The `llm-wiki-prd` initiative is three subsystems:

| # | Sub-project | What it does | Status |
|---|---|---|---|
| **A** | Notion → Obsidian sync | Discovers PRDs in the Product Backlog DB, converts to clean Markdown, writes to the vault. | **Done & merged.** |
| **B** | **LLM enrichment** | Generates an LLM summary, tags, and "related" backlinks for each synced PRD, writing them into the reserved `llm:` frontmatter block. | **This spec.** |
| **C** | RAG chat | Q&A over the corpus with citations. | Future. |

**B is a consumer of A's data contract.** A writes each PRD as a Markdown file whose frontmatter has two namespaces: `sync:` (A owns, overwritten every nightly run) and `llm:` (B owns; A scaffolds it empty on first write and preserves it value-for-value on every subsequent run). B reads A's output and fills the `llm:` block. A's hardened `parseExisting`/`composeFile` (frontmatter merge) guarantees B's enrichment survives A's nightly re-sync regardless of YAML key order.

**Corpus shape (measured from a live A run):** 132 files, bodies ranging 1.4 KB → 175 KB (≈125× range). Every PRD is well-structured (`## Background`, `## Goal`, `## User Stories` → `### US-01…`, etc.). A already populates `sync.short_summary` from Notion's own column (a human one-liner), so B's summary must add value beyond that.

---

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Enrichment scope | **summary + tags + related** (the full `llm:` block) | Complete enrichment vision. |
| LLM provider | **User's own endpoint** — custom base URL + API key, model **MiniMax (M2)** | User-controlled, clean for unattended runs. |
| LLM API shape | **Assumed OpenAI-compatible** (`/v1/chat/completions`), isolated behind one `llm-client` module | MiniMax M2 is OpenAI-compatible; the exact shape is a config/adapter detail, not an architectural commitment. **To confirm at implementation:** exact base URL, model string, and that it is OpenAI-compatible. |
| Large-doc handling | **Head + structure extract** (distilled view) | PRDs are well-structured; frontmatter + headings + first-N-chars per section capture the gist at bounded cost. Small docs (< threshold) sent whole. |
| Re-enrich trigger | **`llm` empty OR body changed** (incremental) | Re-enrich only when never-enriched or the body actually changed (by content hash, not A's clock). |
| Related detection | **LLM-judged pairs**, pre-filtered to **top-K per doc by overlap** | LLM quality on a bounded candidate set (N×K calls), predictable regardless of corpus density. |
| Related symmetry | **Symmetric** — recorded on both docs, deduped | Keeps the graph consistent (D→C implies C→D). |
| Schedule | **Chained after A, nightly** (A ~3 am, B ~4 am) | Enrichment always reflects the latest sync; vault synced + enriched by morning. |
| Manual run | Also runnable as `npm run enrich` | On-demand refresh while tuning prompts/cost. |

### To confirm before implementation
1. The exact LLM **base URL**, **model string**, and whether the endpoint is **OpenAI-compatible** (the design assumes it is; if native MiniMax, only `llm-client.ts` changes).

---

## 3. Architecture

A second Node/TypeScript CLI in the same `llm-wiki/` project, reusing A's frontmatter, deadline, keychain, and atomic-write utilities. Runnable manually (`npm run enrich`) and chained after A's nightly sync.

```
enrich/
├─ enrich-config.ts   Settings: LLM base URL + key (keychain), model, vault path,
│                     K (related top-K), distill size thresholds. Validates on startup.
├─ llm-client.ts      The ONE swappable module. enrich(messages, schema) → validated
│                     JSON. OpenAI-compatible by default. Owns retries, timeout, backoff.
├─ distill.ts         Large-doc handling: frontmatter + headings + first-N-chars per
│                     section → a bounded "distilled view". Small docs pass through whole.
├─ summarize.ts       Per-doc: distilled view → { summary, tags } via llm-client against
│                     a JSON schema. Pure prompt-building + parse + tag normalization.
├─ relate.ts          Cross-doc: candidate generation (top-K by overlap) → LLM-judge each
│                     candidate → ranked, symmetric related[].
├─ enrich-writer.ts   Reads a vault .md, writes ONLY the llm: block via A's frontmatter
│                     merge (sync: + body untouched). Atomic temp+rename.
├─ enrich-state.ts    Per-doc enriched_at + body_hash bookkeeping (in the llm: block)
│                     to drive incremental + resumability.
└─ enrich-index.ts    Orchestrator: Phase 1 (summarize changed docs) → Phase 2 (relate),
                      run summary, exit code.
```

### Reused from A (not rebuilt)
- `frontmatter.ts` — the hardened `parseExisting` (structured `llm` extraction by key, fail-safe on parse error) and `composeFile`. B writes `llm:`; A's contract preserves it.
- `withDeadline` — wall-clock bound on each LLM call.
- Keychain token pattern (`security find-generic-password …`) for the LLM API key.
- Atomic temp-file + rename write discipline.

---

## 4. Data Flow & LLM Contract

### What B writes (the `llm:` block — A's reserved namespace)
```yaml
llm:
  summary: "One-paragraph digest: what this PRD delivers, for whom, current status."
  tags: [saudi, notifications, crm, email, roshn]   # 3-8 normalized kebab-case tags
  related:
    - "[[EP-829-prd-1-platform-foundation-ringkas-portal]]"   # ranked wikilinks
    - "[[EP-834-saudi-api-endpoint-for-saudi-banks]]"
  enriched_at: 2026-06-19T04:10:00Z   # B bookkeeping (B owns; A preserves)
  body_hash: "a1b2c3…"                # sha256 of the body B enriched from
```
A preserves the entire `llm:` value subtree by key, so the two bookkeeping fields (`enriched_at`, `body_hash`) are safe additions — **no change to A required.**

### Phase 1 — Summarize (per doc, independent)
```
distilled view ──► llm-client(schema {summary: string, tags: string[]}) ──► validate ──► llm.summary + llm.tags
```
- **Distilled view** = frontmatter (title, short_summary, status, platform, strategic_goal) + every `##`/`###` heading + first ~200 chars under each. Bodies below the size threshold (~8 KB) are sent whole.
- LLM is **forced to return JSON matching the schema**; output is validated before any write.
- **Tag normalization** (lowercase, kebab-case, dedupe, basic singularize) — load-bearing because Phase 2 candidates are computed from tag overlap; inconsistent tags silently lose real candidates.

### Phase 2 — Relate (cross-doc, after all Phase-1 tags exist)
```
for each doc D:
  candidates = top-K docs by overlap score = (shared tags × 2) + shared platform + shared strategic_goal
  for each candidate C:  LLM-judge(D.summary, C.summary) → { related: bool, reason }
  D.related = confirmed candidates, ranked by overlap score, as [[wikilinks]]
record symmetrically: if D relates to C, C relates to D (deduped)
```
- LLM judges from **summaries** (computed in Phase 1), not full bodies — cheap.
- A doc never relates to itself (self-exclusion).

### Why two phases
`related` depends on every doc's `tags` existing (candidates come from tag overlap), so Phase 1 must complete corpus-wide before Phase 2. Phase 1 is per-doc independent (parallelizable, resumable); Phase 2 is the bounded N×K LLM-judge pass.

### Cost envelope (132 docs, K=5)
Cold full run ≈ 132 summary calls + ≤ 660 judge calls ≈ **~800 LLM calls**. Incremental runs touch only changed docs + affected neighborhoods. Bounded and predictable; grows linearly (N×K), not quadratically.

---

## 5. State, Incremental & Resumability

- **Bookkeeping lives in the `llm:` block** (`enriched_at`, `body_hash`) — no separate state file needed for per-doc status; the vault file is self-describing. (An optional `enrich/.enrich-state.json` may cache cross-run corpus data like the tag index, but is not the source of truth.)
- **Phase-1 re-enrich** a doc if: `llm.summary` is null (never enriched) OR `sha256(current body) ≠ llm.body_hash` (real content change).
  - Hashing the **body B enriched from** (not A's `last_edited`) means re-enrichment fires on *actual* content change — A's nightly re-sync rewrites the body region with a fresh `synced_at` even when Notion content is byte-identical, so the clock alone would over-trigger.
- **Phase-2 re-relate** for a doc if its own tags changed OR any candidate's tags changed. Pragmatic default: cold start = all docs; steady state = re-run Phase 2 for the neighborhoods of docs that were re-enriched in Phase 1.
- **Resumability:** a crash mid-Phase-1 loses no work — a re-run skips docs whose `llm:` is already current.

---

## 6. Error Handling

Principle (inherited from A): **one bad doc never aborts the run or corrupts a good file.**

| Failure | Behavior |
|---|---|
| LLM call fails / times out | `llm-client` retries with bounded backoff; each call wrapped in `withDeadline`. After cap → skip that doc this run, log, count as error. Existing `llm:` left **untouched** (never overwrite good enrichment with a failure). |
| LLM returns malformed / schema-invalid JSON | Reject; retry once with a "return valid JSON matching schema" reminder. Still bad → skip doc, log. Never write unvalidated data. |
| Doc frontmatter won't parse | Reuse A's fail-safe (`parseExisting` parse-error path): skip the file, log, never overwrite. |
| Phase-2 judge fails for a pair | Skip that pair (treat as not-related), continue. A missing edge is acceptable; a crashed run is not. |
| Rate limits | Respect `Retry-After`/backoff; small concurrency cap so the endpoint isn't hammered. |
| Write atomicity | Temp file + atomic rename (A's pattern), so an interrupted write never leaves a half-written `.md`. |

**Run summary (always printed):** `enriched N · skipped M · related-pairs J · errors E`. Non-zero exit on errors so the chained launchd job surfaces it.

---

## 7. Testing Strategy

TDD the pure logic against fixtures; mock the LLM boundary; one live smoke run.

| Layer | Approach |
|---|---|
| `distill.ts` | Unit tests vs fixtures: large body → distilled view contains all headings, bounded per-section chars, under size budget; small doc passes whole; no-headings edge case. |
| `summarize.ts` | Unit tests with **mocked `llm-client`**: fixed JSON response → correct parse + tag normalization (lowercase/kebab/dedupe); malformed JSON → reject/retry path. |
| `relate.ts` | Unit tests, **pure candidate math**: known tags/metadata → correct top-K overlap ordering; symmetric recording; self-exclusion. LLM-judge mocked. |
| `enrich-writer.ts` | Writing `llm:` leaves `sync:` + body byte-identical; `enriched_at`/`body_hash` round-trip; malformed existing file is **not** overwritten (fail-safe). Reuses A's frontmatter test patterns. |
| incremental (`enrich-state` + `body_hash`) | body_hash unchanged → skip; changed → re-enrich; null summary → enrich; resumability after a simulated mid-run stop. |
| `llm-client.ts` | **Mocked-HTTP** tests: retry/backoff, `withDeadline` timeout, schema-validation reject. No live endpoint in CI. |
| End-to-end | **One manual smoke run** against the real vault + real MiniMax endpoint into a throwaway vault copy: a known doc (EP-838) gets a sane summary, normalized tags, ≥1 plausible related link; a second run is a no-op (incremental). Not automated (needs live key + endpoint). |

Fixtures in `enrich/test/fixtures/`. No live LLM calls in the automated suite — the live MiniMax behavior (exact API shape, real context limit, tag quality, latency × ~800 calls) is validated only by the smoke run, the same way A's live runs caught what unit tests could not.

---

## 8. Out of Scope (sub-project B)

- RAG / vector indexing / chat — **sub-project C.**
- Embedding-based related detection (B uses tag-overlap candidates + LLM-judge; embeddings overlap with C's work).
- MOC / index pages (could be a small later addition; B focuses on per-doc `llm:` enrichment first).
- A controlled/curated tag vocabulary (B normalizes deterministically; a managed taxonomy is a later refinement).
- Any change to sub-project A. B only reads A's output and writes the `llm:` block A already preserves.

---

## 9. One-Time Setup (prerequisite for implementation)

1. Obtain the LLM endpoint details: **base URL**, **model string**, confirm **OpenAI-compatible**.
2. Store the API key in the macOS keychain (mirroring A's Notion-token pattern), e.g. `security add-generic-password -s ringkas-prd-enrich -a llm-api-key -w '<KEY>'`.
3. Capture base URL + model + K + thresholds into `enrich-config.ts` settings.
