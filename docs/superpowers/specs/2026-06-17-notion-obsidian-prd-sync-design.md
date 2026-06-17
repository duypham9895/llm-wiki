# Notion → Obsidian PRD Sync (Sub-project A)

**Date:** 2026-06-17
**Status:** Design approved, pending implementation plan
**Scope:** Sub-project A of the `llm-wiki-prd` initiative.

---

## 1. Context & Decomposition

The `llm-wiki-prd` goal — "clone all PRDs from Notion into Obsidian and build an LLM wiki on top" — is three subsystems, built in order:

| # | Sub-project | What it does | Depends on |
|---|---|---|---|
| **A** | **Notion → Obsidian sync** | Cron job discovers all PRDs, fetches them, writes clean `.md` into the vault. Idempotent, incremental. | — |
| **B** | LLM vault enrichment | Auto summaries, tags, backlinks, MOC/index pages over the synced PRDs. | A |
| **C** | Chat / RAG layer | Q&A over the corpus with citations to source PRDs. | A (B optional) |

**This spec covers sub-project A only.** B and C get their own spec → plan → build cycles.

A is the foundation: B and C both consume the markdown A produces. A therefore defines the **data contract** (frontmatter schema, file naming, link format) the other two rely on. The high-level vision for B and C exists only to constrain A's output format:

- **B** needs structured YAML frontmatter (stable ID, status, area, `last_edited`) and a reserved frontmatter namespace it owns, so a re-sync never clobbers its enrichment.
- **C** needs clean chunk-friendly markdown and per-file provenance (source URL + title) for citations, plus `last_edited` to re-embed only changed PRDs.

---

## 2. The Source (verified against real data)

The "PRD database" is the Notion database **`🚀 Product Backlog (EPIC)`**
(`https://app.notion.com/p/3f6ac86135fd48d0925299a9e202b776`, data source `cc477810-e934-412f-b99b-16f4029fba6c`), under the parent page **"Product Management"**.

- Each **row is an Epic**; the PRD narrative lives in the **row's page body** (`<content>` block), authored from one of three templates: *PRD Format*, *Design Brief*, *AI PRD*.
- PRD bodies are large and **table-heavy** (a real sample, "PRD 2", was 291 KB / ~8,600 lines with 219 tables, toggles, callouts, and in-body cross-PRD `mention-page` links).
- "PRD" content also exists **outside** the database as satellite pages (Feedback, FE Tasks, Timeline proposals, archived experiments) — some are pages, some are sub-databases.

### Key columns (real schema)

| Column | Type | Used as |
|---|---|---|
| Epic Name | title | `title` |
| ID (`userDefined:ID`) | string (e.g. `"EP-827"`) | filename handle for canonical PRDs |
| Status | status (9 values) | `status` |
| Platform | multi-select | `platform` (area) |
| Strategic Goal | multi-select | `strategic_goal` |
| Short Summary | text | `short_summary` (seeds B) |
| Complexity, Rank #, Revenue Impact ($/mo) | select/text/number | metadata |
| Product PIC / Feature Reviewer / Sponsor | person (user IDs) | resolved to names |
| Parent item / Sub-item | relation | hierarchy wikilinks |
| TRD | relation (other DB) | plain reference (not wikilink) |
| Last edited time | timestamp | `last_edited` — drives incremental sync |

**Status values:** `Not Started`, `Requirement in Progress`, `Blocked`, `Requirement Finalized`, `In Development`, `Stakeholder Testing`, `Ready for Released`, `Cancelled`, `Released`. (`Cancelled`/`Released` = Notion's "Complete" group — **these stay active in the vault**, see archive rule.)

---

## 3. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Auth | Notion **internal integration token** | Unattended cron has no human to re-approve OAuth. Token is long-lived, scoped to shared pages only. |
| Stack | **Node/TypeScript** — `@notionhq/client` + `notion-to-md` | Markdown fidelity is the whole game (219 tables/PRD). Node's converter is the most mature. |
| Discovery | **Product Backlog DB enumeration only** (no `/search`) | **Revised 2026-06-18 after live run:** `/search "PRD"` matched **828** items (tickets, templates, subtasks) — unusable noise. DB-only is clean and bounded. |
| Scope | **DB rows with real body content** (body-content filter) | **Revised 2026-06-18 after live run:** the DB has **715 rows**, but **423 are "Not Started" stubs** and only ~148 have a Short Summary. Sync a row only if its page body has meaningful content (≥ threshold of non-whitespace chars); skip empty placeholders. |
| API timeout | **`@notionhq/client` constructed with `timeoutMs: 30000`** | **Added 2026-06-18 after live run:** a page's block fetch (via `notion-to-md`) hung with no timeout, stalling the whole unattended run. A client-level timeout bounds every API call. |
| Archive trigger | **Only when a row is removed from Notion** (or drops below the content threshold) | `Released`/`Cancelled` PRDs are valid shipped-feature docs; keep them. A row that loses its body falls out of the synced set like a removal. |
| Images | **Download locally** to `_attachments/<id>/`, each fetch bounded by a 30s timeout | Notion signed URLs expire ~1h; local copies render forever and are RAG-safe. A hung image download cannot stall the run. |
| Schedule | **A few times/day via launchd**, incremental | launchd is more reliable than crontab on a sleeping laptop. Incremental via `last_edited`. |
| Manual run | Also runnable as `npm run sync` | On-demand force sync alongside the schedule. |

### Confirmed assumptions
1. The canonical PRDs and substantive epics all live in the **Product Backlog (EPIC) database**; satellite pages outside it are out of scope (the broad `/search` net was abandoned after it returned 828 noisy items).
2. Every synced row is a DB row, so every file gets a clean **`EP-` id** filename. The `satellite`/`db-index` kinds are no longer produced (no search pass); `kind` is `canonical-prd` or `archived` (by title marker).
3. A row is "real" if its page **body content** meets a non-whitespace character threshold (default 300; tunable). Stubs below it are skipped and recorded so they are not re-fetched every run.
4. **TRD links defer to a later sub-project** — stored as plain references now, not wikilinks.

### Superseded (original brainstorming assumptions, kept for history)
- ~~"Everything matching PRD", classified not dropped~~ → 828 items, abandoned for DB-only.
- ~~Satellites get title-based filenames~~ → no satellites synced.
- ~~Database-type results indexed as `db-index` list pages~~ → no search, so no database-type results.
- ~~Parent/Sub-item hierarchy wikilinks~~ → 713/715 rows are top-level; effectively no hierarchy. `parent`/`sub_items` frontmatter retained but usually empty.

---

## 4. Architecture

A single Node/TypeScript CLI in `llm-wiki/`, runnable manually (`npm run sync`) and on schedule (launchd). Small single-purpose modules:

```
notion-obsidian-sync/
├─ config.ts    Load + validate settings: integration token (keychain),
│               database ID, parent page ID, vault path, search term.
├─ notion.ts    Notion API wrapper: enumerate DB (paginated), search,
│               fetch page blocks (paginated at 100/req), resolve user IDs→names.
│               Owns retries + rate-limit backoff.
├─ discover.ts  Two-pass discovery (DB + search), dedupe by UUID, classify
│               each result into kind (canonical-prd | satellite | archived | db-index).
├─ convert.ts   Blocks → GFM markdown (notion-to-md). Rewrite in-body
│               mention-page → [[wikilink]] when target is synced. Build frontmatter.
├─ assets.ts    Download images/files → _attachments/<id>/, rewrite links to local.
├─ writer.ts    Write/update .md. Owns the sync.* vs llm.* merge rule + _Archive moves.
├─ state.ts     Read/write sync state (seen UUIDs, last_edited per page). Drives incremental.
└─ index.ts     Orchestrator: run pipeline, print run summary.
```

### Data flow per run

```
discover (DB enum + search, dedupe, classify)
  └─ for each item:
       compare last_edited vs state
         ├─ unchanged ──► skip
         └─ new/changed ──► fetch blocks ──► convert ──► download assets
                              ──► merge frontmatter (preserve llm.*) ──► write .md
  detect UUIDs in state but absent from this run's discovery
     ──► mark removed_from_notion, move file to _Archive/
  write state ──► print summary (synced N, skipped M, archived K, errors E)
```

---

## 5. Data Contract

### File layout (in the Obsidian vault)
```
<vault>/PRDs/
├─ EP-827-client-management-risa.md     canonical PRD (ID-prefixed)
├─ feedback-for-prd-1-a1b2.md           satellite (title-slug + uuid suffix)
├─ _attachments/<id>/<image>.png        images per item, namespaced by id
├─ _Archive/<id>-<slug>.md              only items removed from Notion
└─ _MOC.md, _index*                     RESERVED for sub-project B; A never writes
```
Flat folder; `kind` lives in frontmatter, not folders. Archived files keep their slug so backlinks survive the move.

### Filename
- **Canonical:** `<EP-ID>-<epic-slug>.md`.
- **Satellite (no EP- ID):** `<title-slug>-<short-uuid>.md`.
- Slug collisions resolved with the short UUID suffix.

### Frontmatter — namespace split
`sync.*` = **A owns, overwritten every run, never hand-edit.**
`llm.*` = **B owns; A scaffolds empty on first write, then preserves verbatim.**

```yaml
---
sync:
  id: "EP-827"                 # string ID (canonical) or title-slug (satellite)
  uuid: 33d44805-d442-817c-8de7-cb19fcea1d83   # Notion page UUID — the join key
  source_url: https://app.notion.com/p/...
  title: "PRD 2: Client Management — RISA Configuration Portal"
  kind: canonical-prd          # canonical-prd | satellite | archived | db-index
  canonical: true
  status: Requirement in Progress
  platform: [AI Agent]
  strategic_goal: [RISA-NXT]
  short_summary: "Full client lifecycle: tenant onboarding, cost controls..."
  complexity: High
  rank: ""
  revenue_impact_usd_mo: null
  product_pic: ["<resolved name>"]
  parent: "[[EP-800-...]]"     # relation → wikilink by ID handle (empty if none)
  sub_items: []                # relation → wikilinks
  depends_on: ["[[EP-815-...]]"]   # from in-body <mention-page> to synced targets
  trd_refs:                    # other-DB relations → plain reference, NOT wikilink
    - "Multi-Tenant Tech Doc — https://app.notion.com/p/..."
  template_type: "PRD Format"  # PRD Format | Design Brief | AI PRD | null
  created_time: 2026-04-09T06:40:05Z
  last_edited: 2026-06-17T07:20:38Z
  synced_at: 2026-06-17T09:00:00Z
  removed_from_notion: false
llm:
  summary: null
  tags: []
  related: []
---
<clean GitHub-flavored markdown body — A overwrites this region every sync>
```

### Classification rules
| `kind` | Rule | `canonical` |
|---|---|---|
| `canonical-prd` | Page is a row in the Product Backlog DB | `true` |
| `satellite` | Matches "PRD", not in the DB | `false` |
| `archived` | Title contains `[Archived]` or `[Experiment]` | `false` |
| `db-index` | Discovery result is `type: database` → one list page (titles + links), rows not expanded | `false` |

### Conversion rules (`convert.ts`)
1. Notion blocks → **GFM markdown**: `| pipe |` tables, real headings, standard callouts, lists. Toggles flattened to headings + content (Obsidian has no native toggle in reading view).
2. In-body `<mention-page>` → `[[wikilink]]` **if** the target UUID is in this run's synced set; otherwise a plain markdown link to the Notion URL (no dangling `[[ ]]`).
3. Escaped artifacts from Notion (e.g. `\[US-01\]`) normalized to clean text.
4. TRD / other-database relations → plain `trd_refs` references, never wikilinks.

### The merge rule (`writer.ts`)
On each run, for an existing file: parse it, **preserve the entire `llm:` block verbatim**, replace only the `sync:` block and the markdown body. First time a page is seen: scaffold an empty `llm:` block. This is the dead-simple alternative to a merge engine — A and B touch disjoint regions.

---

## 6. State, Incremental Sync & Idempotency

- **State file:** `notion-obsidian-sync/.sync-state.json` (outside the vault), mapping `uuid → { id, filename, last_edited, synced_at, kind }`.
- **Incremental:** an item is re-fetched only if its `last_edited` is newer than state (or it's new). Unchanged items are skipped — keeps API usage and runtime low.
- **Idempotency:** re-running with no Notion changes is a no-op (every item skipped, no file writes). Safe to run as often as scheduled.
- **Archive detection:** any UUID present in state but absent from the current discovery union is treated as removed-from-Notion → its file is moved to `_Archive/`, `sync.removed_from_notion: true`. (Re-appearing later moves it back.)
- **People cache:** resolved user IDs→names cached in state to avoid re-resolving every run.

---

## 7. Error Handling

Principle: **a single bad page must never abort the whole run or corrupt good output.**

| Failure | Behavior |
|---|---|
| Notion rate limit (HTTP 429) | Respect `Retry-After`, exponential backoff, capped retries in `notion.ts`. |
| Transient network / 5xx | Retry with backoff; after cap, log and skip that item (counts as error). |
| Single page fetch/convert fails | Log, **skip that item, continue the run.** The previous local file is left untouched (not overwritten with garbage). |
| Image download fails | Keep the item; leave a `![alt](notion-url) <!-- download failed -->` placeholder so the rest of the doc still syncs. |
| Auth invalid/expired | Abort early with a clear message (token must be refreshed in keychain). No partial corruption. |
| Write/atomicity | Write to a temp file, then atomic rename, so an interrupted run never leaves a half-written `.md`. |
| `llm.*` parse failure on existing file | Fail safe: do **not** overwrite the file; log it for manual inspection (never destroy B's enrichment). |

**Run summary** (always printed): `synced N · skipped(unchanged) M · archived K · errors E`, with the list of errored items for follow-up. Non-zero errors → non-zero exit code (so launchd/log surfaces it).

---

## 8. Testing Strategy

Built TDD where it pays off — the conversion and merge logic, which are pure functions over fixtures.

| Layer | Approach |
|---|---|
| `convert.ts` | **Unit tests against saved fixtures** (real Notion block JSON → expected GFM). Cover: tables, nested toggles, callouts, mention-page→wikilink (synced vs unsynced target), escaped brackets, images. The captured PRD 2 body is a fixture source. |
| `writer.ts` merge rule | **Unit tests:** existing file with `llm.*` filled → assert `llm.*` preserved byte-for-byte, `sync.*` + body replaced. First-write scaffolds empty `llm.*`. |
| `discover.ts` classification | **Unit tests:** given mixed search/DB results → assert correct `kind`/`canonical` per item; dedupe by UUID; satellite vs canonical filename rules. |
| `state.ts` incremental | **Unit tests:** unchanged `last_edited` → skip; newer → re-fetch; UUID gone → archive; re-appeared → un-archive. |
| `notion.ts` | **Mocked API tests** for pagination (>100 blocks) and 429 backoff. No live calls in CI. |
| End-to-end | **One manual smoke run** against the real workspace into a throwaway vault dir, verifying a known PRD (EP-827) lands with correct frontmatter, clean tables, and local images. Not automated (needs live token). |

Fixtures live in `notion-obsidian-sync/test/fixtures/`. No live Notion calls in the automated suite.

---

## 9. Out of Scope (sub-project A)

- LLM enrichment (summaries, tags, inferred `related`, MOC pages) → **sub-project B.**
- Chat / RAG / vector indexing → **sub-project C.**
- Syncing the TRD database or expanding sub-database rows.
- Two-way sync (Obsidian → Notion). A is strictly one-way, read-from-Notion.
- Real-time/webhook sync. A is scheduled-poll only.

---

## 10. One-Time Setup (prerequisite for implementation)

1. Create a Notion **internal integration**; copy its token.
2. **Share** the integration on the "Product Management" parent page (access inherits to the Backlog DB + descendants).
3. Store the token in the macOS keychain (mirroring the existing `notion-mcp` pattern; never in repo/.env-in-git).
4. Capture the database ID and parent page ID into `config.ts` settings.
