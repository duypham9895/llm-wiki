# Phase 5 — Half-Built Features, Dead Code, UX Regressions Audit

**Scope:** every page + every non-UI component in `mcp/web-ui/src/`, audited against the Phase 4 spec
(`docs/superpowers/specs/2026-06-25-phase4-ui-redesign-design.md`), the Phase 3 spec
(`docs/superpowers/specs/2026-06-20-web-dashboard-design.md`), and the Phase 4 status report
(`.superpowers/sdd/phase4-status-2026-06-25.md`).
**Date:** 2026-06-26
**Method:** read every file listed in the prompt; cross-referenced each finding against the
relevant spec section; every "verify" step below is reproducible in a browser without backend access.

---

## 1. Dead code & placeholder strings

### 1.1 Invite button is a toast, not a flow
**File:** `mcp/web-ui/src/pages/admin/DirectoryPage.tsx:385-392`
**Spec says:** F4 Directory — `+ Invite` action and reset-password / manage-roles / disable /
delete flow.
**What's there:** `onClick={() => toast.info('Invite flow coming soon')}` with `data-testid="invite-button"`.
**How to verify:** Sign in as admin → /admin/directory → click "+ Invite" → a sonner toast appears
with the literal text "Invite flow coming soon"; no modal, no API call.
**Difficulty:** medium (no invite endpoint exists; needs backend `POST /admin/invitations` and a dialog).

### 1.2 Empty-state copy on Directory encourages inviting, but invite is dead
**File:** `mcp/web-ui/src/pages/admin/DirectoryPage.tsx:414, 419`
**Spec says:** F4 — Invite is a real action.
**What's there:** Both the table-empty and page-empty branches show
`<EmptyState … description="Invite a teammate to get started." />` — yet the only way to actually
invite is the dead toast above.
**How to verify:** /admin/directory with the users array empty (or after `filtered = []`) → the
CTA the empty state tells you to do is unreachable.
**Difficulty:** medium (depends on 1.1).

### 1.3 SourcesPage spec includes a "Confluence (coming soon)" card
**File:** Phase 4 spec `2026-06-25-phase4-ui-redesign-design.md:257` (`○ Confluence (coming soon)`)
vs.
**SourcesPage.tsx** renders only what's returned from `GET /admin/sources`; no hardcoded "coming soon" row.
**What's there:** The spec was simplified in implementation (good — fewer fake rows) but the spec
itself still advertises a card that won't exist until a second source is added.
**How to verify:** grep the page for "Confluence"; nothing renders. The spec doc retains the
"coming soon" line as a design fiction.
**Difficulty:** trivial (delete the spec line; or implement Confluence).

### 1.4 StatCard component is built but unused
**File:** `mcp/web-ui/src/components/StatCard.tsx` (entire file, 51 lines) is shipped in the bundle
(`import`-able in components barrel) but never imported by any page or other component.
**How to verify:** grep `StatCard` across `mcp/web-ui/src/` — the only hit is the file itself.
StatusPage would be the obvious consumer (Coverage card, pipeline stage counts) but renders a
hand-rolled `<article>` instead.
**Difficulty:** easy (either use it on StatusPage or delete the file).

### 1.5 `ConversationList` is wired but the doc still flags it as "orphan"
**File:** Phase 4 status report line 20 still lists `ConversationList (orphan — see notes)`.
**Reality:** `AskPage.tsx:379-393` already imports and renders `<ConversationList … />` with all
mutation/pending state.
**How to verify:** Render /ask with one conversation → the rail shows the entry with a delete icon.
**Difficulty:** trivial (update the status doc — and double-check the spec didn't intentionally
defer the "rail" pattern in favor of a dropdown).

### 1.6 RequirePermission falls back to plain English on 403
**File:** `mcp/web-ui/src/components/RequirePermission.tsx:9`
**What's there:** `return <p>You don't have access to this page.</p>;`
**Spec says:** Phase 4 design DNA — friendly empty states with icon, title, body, CTA. The bare
paragraph breaks the system and looks broken rather than permissioned.
**How to verify:** sign in with a non-admin role and visit /admin/roles → bare text in the main
slot; no `<EmptyState>`, no icon, no Link back.
**Difficulty:** easy (swap to `<EmptyState icon={Shield} title="Restricted" … />`).

---

## 2. Half-wired features

### 2.1 PRD Detail "Re-run enrichment" menu item — specced, not implemented
**File:** `mcp/web-ui/src/pages/PrdDetailPage.tsx` (entire file).
**Spec says:** F1 — Actions menu `⋯`: "Copy ID · Copy Obsidian link · Open in Notion · Re-run
enrichment (admin only)".
**What's there:** Only "Open in Notion" (line 91) is exposed via `PageHeader actions`. No `⋯`
dropdown, no copy-ID, no copy-obsidian-link, no re-enrich trigger. The spec explicitly says
"wire up the button, leave the actual enrich call to a thin stub that returns 'started'" — even
the stub is missing.
**How to verify:** Open /library/EP-XXX → no overflow menu visible anywhere; no way to copy the
PRD id without selecting text manually.
**Difficulty:** medium (DropdownMenu + 3 trivial handlers + 1 stub toast).

### 2.2 PRD Detail "Tabs (Body · Metadata · Conversations · History)" — specced, not built
**File:** `mcp/web-ui/src/pages/PrdDetailPage.tsx`.
**Spec says:** F1 — `Tabs` primitive with Body (default) · Metadata · Conversations · History.
**What's there:** Flat two-column layout (TOC + body) + a hard-coded metadata `<dl>` (lines
136-157). No `<Tabs>` from `@/components/ui/tabs` is imported, and no /api/prd/{id} endpoint is
called for metadata/conversations/history beyond the initial body read.
**How to verify:** /library/EP-468 → no tab strip exists. Status report line 27 says
"Body/Metadata/History" shipped, but only Body + a static dl are actually wired.
**Difficulty:** medium (shadcn Tabs is already installed; needs 3 endpoints and a stub History list).

### 2.3 CommandPalette recent PRDs is a fake "recent"
**File:** `mcp/web-ui/src/components/CommandPalette.tsx:89-98`
**Spec says:** F3 / F5 — "recent PRDs" as a quick-jump. Phase 3 spec doesn't define this in
detail but the natural meaning is "PRDs the user actually viewed recently."
**What's there:** Calls `/prd/library?limit=8` — that returns the first 8 PRDs in vault order, not
what the user last viewed. Header "Recent PRDs" is misleading.
**How to verify:** Open ⌘K palette → group "Recent PRDs" shows the same 8 PRDs regardless of
browsing history.
**Difficulty:** medium (needs a `recent_prds` endpoint or localStorage last-viewed list).

### 2.4 StatusPage stage cards show no counts/timestamps/duration
**File:** `mcp/web-ui/src/pages/StatusPage.tsx:147-159`
**Spec says:** F2 + Phase 3 §6 — "synced 4 · skipped 0 · archived 0 · errors 0" + `Last run: 2h ago`.
**What's there:** Each stage `<article>` renders only the stage name and an OK/Failed/Unknown
icon-label. The shape `PipelineStage` is `[key: string]: unknown` so fields are discarded.
Spec expects per-stage counts; the data is read from `/status/pipeline` but the page throws it
away.
**How to verify:** Hit /api/mock-status-pipeline with stages `sync: { ok: true, started_at,
finished_at, counts: {…} }` → the page still renders just "sync OK". The SourcesPage tests
(lines 116-122) explicitly assert `card.textContent).toMatch(/synced 4/)` — the SAME spec'd
content — proving StatusPage regressed from the Phase 3 design.
**Difficulty:** medium (read `started_at/finished_at/counts`, render them; copy the SourcesPage
StatusRow pattern).

### 2.5 StatusPage "halted_at" is rendered as a stage label, not a timestamp
**File:** `mcp/web-ui/src/pages/StatusPage.tsx:117`
**Spec says:** Phase 3 §9 "Pipeline: a stage fails its health gate → Status shows the halt +
reason."
**What's there:** Renders `Halted at stage: {pipeline.halted_at}` — but the field is the stage
*name* (e.g. "enrich"), not a timestamp. The test at `StatusPage.test.tsx:72` even asserts
`Halted at stage: enrich`, which is the symptom: the schema for `halted_at` is overloaded.
**How to verify:** Any 502 from the orchestrator → banner says "Halted at stage: enrich" with no
wall-clock time. No `<RelativeTime>` on it.
**Difficulty:** easy (split into `halted_stage` + `halted_at` or render a separate `<RelativeTime>`).

### 2.6 StatusPage "History" sidebar shows free-form labels, not durations
**File:** `mcp/web-ui/src/pages/StatusPage.tsx:42-57, 168-181`
**Spec says:** Phase 3 §6 orchestrator summary lists each orchestrator run with start/end + ok/halts.
**What's there:** Builds `runId · stageCount stages · OK` from whatever shape backend returns —
no duration, no absolute timestamp, no error sample. Every row is identical-typography text.
**How to verify:** /status with 3 history runs → the 3 rows look like `r1 · 3 stages · OK` and
nothing else. Spec called for a "trend" list.
**Difficulty:** medium.

### 2.7 SourcesPage poll interval is hard-coded by raw state, not by `running` field correctly
**File:** `mcp/web-ui/src/pages/admin/SourcesPage.tsx:65-69`
**Spec says:** Polling 5s while any source runs, 30s idle.
**What's there:** Reads `data.some((s) => s.status === 'running')`. Status enum includes `running`
so this works, but the inner `<SourceCard>` at line 177 also sets `refetchInterval: source.status
=== 'running' ? 5_000 : 30_000` — same condition twice; safe but redundant.
**How to verify:** No bug today, but if backend introduces a 4th `status` value (`queued`?) the
card will silently drop to 30s and miss updates.
**Difficulty:** easy (refactor to read `runRow?.status === 'running'` for the per-card interval).

### 2.8 SourcesPage "Never run" label conflicts with "Last run: never"
**File:** `mcp/web-ui/src/pages/admin/SourcesPage.tsx:218-224`
**What's there:** `statusLabel` returns `'Never run'` when `source.status === 'idle'`, but
`<RelativeTime>` returns `'less than a minute ago'` for new timestamps; meanwhile line 219 shows
`Last run: never` literally (string `'never'`) when `last_run_at` is null. Two competing idioms
in the same StatusRow.
**How to verify:** Stop the cron → next refresh shows "Last run: never" alongside the StatusDot
saying "Never run".
**Difficulty:** trivial (pick one; reuse `<RelativeTime>` placeholder).

### 2.9 ChangePasswordDialog does not force re-login after success
**File:** `mcp/web-ui/src/components/ChangePasswordDialog.tsx:58-66`
**Spec says:** F4 — "Success: toast 'Password updated' + auto sign-out (forces re-login with new
password) OR keep session — pick whichever the backend already supports; if ambiguous, ask Duy".
**What's there:** `toast.success('Password updated'); onOpenChange(false);` — session is kept
silently. No re-login prompt. The decision flag was never raised.
**How to verify:** Change password in the user menu → dialog closes → user can keep using the app
on the old session cookie. Backend may or may not rotate it.
**Difficulty:** easy if backend supports sign-out, otherwise medium (depends on backend contract).

### 2.10 ApprovalsPage hard-codes raw `POST /admin/users/{id}/approve` route
**File:** `mcp/web-ui/src/pages/admin/ApprovalsPage.tsx:57-62`
**Spec says:** Phase 3 §10 admin_pair / last_admin surfaced "humanely".
**What's there:** Sends `{ role_ids }` for approve and `{}` for reject; reject sends no body
(`body: undefined`) but `apiFetch` in `api.ts:25-28` only sets `Content-Type: application/json` when
`body !== undefined`, so reject has no JSON header — backend may 415 on some frameworks. The
test at `ApprovalsPage.test.tsx:36-49` asserts the admin_pair friendly copy exists but the
actual wording check is `admin.*(fully or not at all|pairs)` — verify that `error-copy.ts` is
actually returning one of those strings.
**How to verify:** Hit Approve on a half-admin pair → expect either "Approve fully or not at all"
or a code leak.
**Difficulty:** easy.

### 2.11 SettingsPage has no empty-state for allowed_domains AND registration on
**File:** `mcp/web-ui/src/pages/admin/SettingsPage.tsx:133-136`
**Spec says:** Phase 3 §9 — "registration toggle, domain allowlist editor."
**What's there:** Shows a warning when domains is empty, but the page has no confirmation
prompt: turning registration on with an empty allowlist will silently block all new signups.
No client-side guard.
**How to verify:** Toggle "Registration enabled" with no domains → click Save → server returns
200, then nobody can sign up.
**Difficulty:** easy (block save when `registrationEnabled && domains.length === 0`).

---

## 3. Regressions vs spec

### 3.1 PRD Detail is missing the conversation/history tabs that the status report claims shipped
**File:** `mcp/web-ui/src/pages/PrdDetailPage.tsx` (no Tabs import).
**Status report line 27:** "tabs (Body/Metadata/History) + status badges + Open in Notion".
**Reality:** Body is the page. Metadata is a static `<dl>` at the bottom of the body column.
History tab is absent. The status report over-claims.
**How to verify:** Open /library/EP-XXX → no tab strip; only one column.
**Difficulty:** medium.

### 3.2 AppShell `g t` shortcut breaks the spec (status = `gt`, not `gs`)
**File:** `mcp/web-ui/src/components/AppShell.tsx:79-87`
**Spec says:** F5 — "G L / G S / G A / G T" → Library/Search/Ask/Status. Spec accepts both `gs`
(Search) and `gt` (Status). Both are sent to `navigate(map[combo])` where `gs` is Search and `gt`
is Status — that's correct.
**But** `SearchPage` is reached via `g s` AND the ⌘K palette says "Search G S". That's fine.
**Status:** no actual bug — but the previous spec sentence "G L / G S / G A / G S" (a copy-paste
typo) was fixed in code while the spec doc still has the typo at line 334 (`g s` listed twice).
**How to verify:** Press "g s" → /search; press "g t" → /status. Spec doc typo is cosmetic.
**Difficulty:** trivial (edit the spec).

### 3.3 Library has filters; Search has filters; Ask has history; Status doesn't have a filter
**File:** `mcp/web-ui/src/pages/StatusPage.tsx` (no input filter on pipeline stage list).
**Spec says:** Phase 3 §7 — Status pipeline coverage and history; nothing explicitly about
filtering.
**Cross-page inconsistency:** LibraryPage has status+tag filters, SearchPage has mode
(semantic/keyword), AskPage has conversation search-by-rail, but Status has no way to filter to
"show only failed runs." Spec doesn't require this, but a PM reviewing a halted chain usually
wants it.
**Difficulty:** medium.

### 3.4 Library has no "recently viewed" — Ask does
**File:** `mcp/web-ui/src/pages/LibraryPage.tsx` (entire file).
**Cross-page inconsistency:** AskPage tracks the active conversation (URL hash) and re-loads on
back/forward. LibraryPage has no per-user history — clicking a PRD updates no client state, so
the CommandPalette "Recent PRDs" (item 2.3) cannot show truth. SearchPage also lacks history.
**How to verify:** Open 5 different PRDs from /library → ⌘K "Recent PRDs" still shows the same
top-of-library 8.
**Difficulty:** medium.

### 3.5 StatusPage "no body" empty state path is unreachable
**File:** `mcp/web-ui/src/pages/PrdDetailPage.tsx:133-135` — the empty-state for a PRD with no
body text is gated behind `body` being falsy. But `query.data.found === true` means backend said
the file exists; an empty vault file would be a vault corruption case, not a UI case. Spec
doesn't address it.
**How to verify:** Mock `/api/prd/EP-X` to return `{ found: true, body: '' }` → renders the
empty state but the surrounding chrome (status badges, Open in Notion) still implies the PRD
has content.
**Difficulty:** trivial (delete the dead branch or hide the chrome when body is empty).

### 3.6 Re-enrichment from PRD detail — explicitly deferred, not stubbed
**File:** `mcp/web-ui/src/pages/PrdDetailPage.tsx` (no enrichment button anywhere).
**Spec says:** Out of scope / Defer — "Re-enrichment trigger from PRD detail — wire up the
button, leave the actual enrich call to a thin stub that returns 'started' and toasts success."
**What's there:** Button not wired, stub not present. The spec calls for at least the affordance.
**How to verify:** /library/EP-XXX → no enrichment button → no "stale body" indicator either.
**Difficulty:** easy (add a `⋯` menu with a Re-enrich item that calls a stub endpoint or just
toasts).

### 3.7 Notification bell placeholder not implemented
**File:** Phase 4 spec F5 — "Right: theme toggle, notifications (placeholder bell for now)".
**What's there:** AppShell top-bar (lines 132-198) has theme toggle and avatar dropdown but
**no notification bell at all**. The spec explicitly accepted a placeholder; the implementation
went further and removed it entirely.
**How to verify:** Look at the top bar → no bell-shaped icon anywhere.
**Difficulty:** trivial (re-add a `Button` with `Bell` icon `aria-label="Notifications" disabled`).

---

## 4. Cross-page inconsistencies

### 4.1 SearchPage uses raw `<input>` while LibraryPage uses shadcn `<Input>`
**File:** `mcp/web-ui/src/pages/SearchPage.tsx:99-107` (raw `<input className="…">`).
vs. `mcp/web-ui/src/pages/LibraryPage.tsx:118-125` (shadcn `<Input>`).
**Spec says:** "Built once in `src/components/ui/` … All features consume from this list — no
one-off styling."
**How to verify:** DOM-inspect the search box and library tag input; both should look identical
in light/dark, focus ring, etc.
**Difficulty:** easy.

### 4.2 ApprovalsPage and RolesPage use raw `<button>` instead of shadcn `<Button>`
**File:** `mcp/web-ui/src/pages/admin/ApprovalsPage.tsx:142-157` (raw `<button
className="inline-flex h-9 items-center rounded-md bg-primary …">`).
**File:** `mcp/web-ui/src/pages/admin/RolesPage.tsx:179-186, 232-239, 293-310` (same pattern).
**vs.** `DirectoryPage.tsx:310, 322, 345` (uses shadcn `<Button variant="ghost">`).
**Spec says:** Same — "no one-off styling." Three admin pages have hand-rolled primary buttons;
DirectoryPage correctly uses shadcn.
**How to verify:** Inspect DOM for `button` with `bg-primary` class on /admin/approvals vs
`/admin/directory — the latter uses CSS variables, the former hardcoded Tailwind colors. Hover
focus rings differ.
**Difficulty:** easy.

### 4.3 SettingsPage uses raw `<input>` for the checkbox
**File:** `mcp/web-ui/src/pages/admin/SettingsPage.tsx:88-93` — `<input type="checkbox"
className="size-5">`.
**vs.** `RolesPage.tsx:129-130, 279-280` — `<input type="checkbox" className="size-4 …">`.
**Spec says:** No one-off styling; `Checkbox` shadcn primitive exists in `ui/` directory (not
audited but present in the dep list).
**How to verify:** Focus state of the registration toggle vs the role checkboxes — the toggle
has no visible focus ring; the roles boxes have an outline.
**Difficulty:** easy.

### 4.4 StatusPage uses no `<PageHeader>`
**File:** `mcp/web-ui/src/pages/StatusPage.tsx:88-92` — hand-rolled `<div><p>…</p><h1>…</h1></div>`.
**vs.** every other page (`LibraryPage.tsx:90`, `SourcesPage.tsx:93`, `DirectoryPage.tsx:369`)
uses the `<PageHeader>` primitive that was explicitly built for this.
**Spec says:** `PageHeader` is a "domain primitive" used by every page.
**How to verify:** Compare title bar styling across /library, /admin/sources, /status — Status
has noticeably different padding/typography.
**Difficulty:** easy.

### 4.5 UserDetailDrawer accepts only a role list, but spec said it shows audit fields too
**File:** `mcp/web-ui/src/components/UserDetailDrawer.tsx:175-203`.
**Spec says:** F4 — "Detail drawer (clicking row): Vaul drawer slides from right; shows audit
fields (last_login, created, last_password_change)."
**What's there:** Audit section renders `created_at`, `last_login_at`, `last_password_change_at`
— correct fields, but they're wrapped in a `<dl>` with side-by-side `flex justify-between`
layout instead of the structured grid `<dl>` shown in the spec ASCII. Minor, but the header says
"Audit" which is a free-text label, not a design-system subhead.
**How to verify:** Click any user row → "Audit" section appears with three rows. No obvious bug
— flagged for spec consistency only.
**Difficulty:** trivial.

### 4.6 AskPage composer placeholder vs. spec
**File:** `mcp/web-ui/src/pages/AskPage.tsx:533` — `placeholder="Ask about a PRD"`.
**Spec says:** ASCII mockup shows `[Ask anything…]`. Small copy divergence.
**Difficulty:** trivial.

### 4.7 LibraryPage status filter only ships 4 of 7 status enums
**File:** `mcp/web-ui/src/pages/LibraryPage.tsx:106-110`.
**What's there:** Filter options `active / draft / archived`. The status badge map at line 47-54
supports 7 statuses (`Active / Draft / Archived / Done / In Review / In Progress / Not Started`)
but the user can't filter to `Done`, `In Review`, `In Progress`, or `Not Started`. So a card with
status `In Review` is unfilterable — yet badges render. Truncated dropdown.
**How to verify:** Visit /library → open the Status dropdown → only 3 entries; vault has more
states.
**Difficulty:** easy.

### 4.8 SourcesPage "Schedule: …" string is rendered raw, no tooltip
**File:** `mcp/web-ui/src/pages/admin/SourcesPage.tsx:238` — `<span>· Schedule: {source.schedule}</span>`.
**Spec says:** "Schedule: every 4 hours" is fine but spec also calls for "Next run: in 4h" — not
implemented. The schedule string is passed through verbatim.
**Difficulty:** easy.

---

## 5. Broken trust signals (status badges / counts / timestamps)

### 5.1 LibraryPage load-more spinner uses raw `<Loader2>` and never resolves on empty
**File:** `mcp/web-ui/src/pages/LibraryPage.tsx:225-229`.
**What's there:** `<p className="…"><Loader2 /> Loading…</p>` rendered when `libraryQuery.isFetching
&& items.length > 0` — but only when the user already has items. On the very first load the
`isFirstLoad` branch (lines 148-164) renders skeletons; that's fine. After filter change the
`<Loader2> Loading…` line is suppressed because `items.length === 0` between transitions.
Visible as "blink then jump to empty state" on slow networks.
**Difficulty:** trivial.

### 5.2 SourcesPage "Last run: never" with a green "OK" dot
**File:** `mcp/web-ui/src/pages/admin/SourcesPage.tsx:218-224`.
**What's there:** When `last_run_at` is `null`, the row shows `Last run: never` but the
`StatusDot` is whatever the `status` field says (often `idle`). The test at
`SourcesPage.test.tsx:108-122` only covers the happy path (`last_run_at` set). A first-run
Notion source will show "Last run: never" + an `idle` gray dot — visually consistent but the
label "Never run" is misleading (it suggests the source has never been tried, when actually
it might be paused/disabled).
**Difficulty:** easy.

### 5.3 StatusPage stage cards drop fields silently
**File:** `mcp/web-ui/src/pages/StatusPage.tsx:36-40`.
**What's there:** `function statusLabel(stage: PipelineStage) { if (stage.ok === true) return
'OK'; if (stage.ok === false) return 'Failed'; return 'Unknown'; }` — and nothing else.
The `PipelineStage` type allows arbitrary fields (`[key: string]: unknown`) but no UI consumes
them. Backend may already return `started_at`, `finished_at`, `counts`, `error_sample` — all
silently discarded.
**How to verify:** Mock `/status/pipeline` to return `stages: { sync: { ok: false, started_at:
'...', error_sample: 'rate limited' } }` → page renders just "sync Failed" with no context.
**Difficulty:** easy (render the fields).

### 5.4 SourcesPage polling can "complete silently"
**File:** `mcp/web-ui/src/pages/admin/SourcesPage.tsx:170-178`.
**What's there:** Each `<SourceCard>` polls `/admin/sources/{id}/runs?limit=10`. When a run
transitions from `running` → `ok`, the card's `refetchInterval` flips from 5s to 30s on next
render — fine — but the `RunningIndicator` (line 271-293) only disappears when `source.status !==
'running'` at the *next* parent refresh. There's a window where the indicator shows "Running
0:14" while the actual run finished 3 seconds ago.
**Difficulty:** easy.

### 5.5 DirectoryPage row counts show 0 even when data exists
**File:** `mcp/web-ui/src/pages/admin/DirectoryPage.tsx:371-372`.
**What's there:** PageHeader has no total-count badge (spec F4 says "Users (24)"). The status
badge and "Last login" column both work, but the page never tells the admin how many users there
are without scrolling. The server response includes `total` (line 60) but the UI discards it.
**How to verify:** Visit /admin/directory with 24 users → no header chip; data only in the
table.
**Difficulty:** easy.

### 5.6 PrdDetailPage skeleton is shown on every render, then content flashes
**File:** `mcp/web-ui/src/pages/PrdDetailPage.tsx:45, 164-189`.
**What's there:** Skeleton renders when `query.isLoading` is true. After the first cache hit
the route does not show the skeleton again — fine. But because `PrdDetailPage` is lazy-loaded
with `<Suspense fallback={null}>`, the very first navigation shows *nothing* for ~50-200ms,
then the skeleton, then content. Trust signal: brief blank flash.
**Difficulty:** easy (replace `null` with a skeleton).

### 5.7 SearchPage has no result-count chip
**File:** `mcp/web-ui/src/pages/SearchPage.tsx:147-182`.
**What's there:** Renders N `<article>` cards but never "Showing 4 of 287 PRDs". Backend returns
`count` (line 22 of types) — discarded by the UI.
**Difficulty:** easy.

### 5.8 StatusPage coverage shows "X / Y enriched" but not the percentage
**File:** `mcp/web-ui/src/pages/StatusPage.tsx:123-131`.
**What's there:** Shows `{coverage.enriched} / {coverage.total} enriched` and
`{coverage.unenriched} not yet processed.` For 200/287 = 69.7% the user has to compute it.
**Difficulty:** trivial.

### 5.9 StatusPage halted banner doesn't show "fixed at" or recovery state
**File:** `mcp/web-ui/src/pages/StatusPage.tsx:106-121`.
**What's there:** Renders the alert unconditionally when `pipeline.halted === true`. After the
orchestrator recovers on the next tick, the banner disappears — but if the user is mid-session
they have no way to know "this banner was here 30s ago." No "fixed at" timestamp.
**Difficulty:** medium (needs sessionStorage or a `last_halt` field).

### 5.10 CommandPalette "Recent PRDs" claim is false (see 2.3 + 3.4)
**File:** `mcp/web-ui/src/components/CommandPalette.tsx:147`.
**How to verify:** Open ⌘K → header literally reads "Recent PRDs" but the items are the first 8
in vault order. Spec did not specify the data source; "Recent" is a trust-signal mismatch.
**Difficulty:** medium.

---

## 6. Permission / endpoint mismatches

### 6.1 SourcesPage permission is `users.manage`; spec says nothing explicit
**File:** `mcp/web-ui/src/lib/permissions.ts:31` and `CommandPalette.tsx:63`.
**Spec says:** F2 "Permission: `users.manage` (admin)." Matches.
**No bug — flagged as baseline.**

### 6.2 SettingsPage is permission-gated on `roles.manage` — but spec placed it under Manage with no perm
**File:** `mcp/web-ui/src/lib/permissions.ts:32`.
**Spec says:** IA — "Admin (hidden unless permission) … Settings (→ /admin/settings)" — does
not name the permission. The choice of `roles.manage` makes intuitive sense (registration toggle
is org-admin only) but no spec line documents this; Duy should validate or change to
`users.manage`.
**Difficulty:** trivial (document or change).

### 6.3 DirectoryPage Manage Roles menu item opens the drawer but the route `/admin/users/:id` does not exist
**File:** `mcp/web-ui/src/components/UserDetailDrawer.tsx:51` (drawer).
**Spec says:** F4 — Manage roles dialog/drawer. Implemented as a Sheet.
**What's there:** Drawer works. No direct `/admin/users/:id` route — clicking a row opens the
drawer (line 408 `onRowClick={openDetail}`). Good.
**No bug — flagged as confirmation.**

### 6.4 ApprovalsPage allows Reject with `role_ids: []` even when roles are checked
**File:** `mcp/web-ui/src/pages/admin/ApprovalsPage.tsx:153-156`.
**What's there:** Reject ignores the selected role checkboxes — sends `roleIds: []`. Test doesn't
cover this. If an admin ticks 2 roles intending to reject the user "with no role grant" and then
clicks Reject, the checked roles are discarded. Tiny UX bug: the UI implies the choices are
meaningful.
**Difficulty:** trivial (disable Reject when roleIds is empty? or reset checkbox state?).

---

## 7. Misc small dead/broken bits

- **`mcp/web-ui/src/pages/admin/SourcesPage.tsx:184`** — `slice(0, 5)` of runs, but the spec mock
  shows "Recent runs" with 10 entries. Minor.
- **`mcp/web-ui/src/components/ConversationList.tsx:124`** — `refreshMs={30_000}` for relative time
  — good. But the parent (`AskPage.tsx`) does not call `queryClient.invalidateQueries` on
  `conversations` after a message is sent except in `onDone` (line 348) — fine, but `updated_at`
  bump for the active conversation is not visually reflected until the next refetch (30s default).
- **`mcp/web-ui/src/components/RequirePermission.tsx`** — No test file (`*.test.tsx`) found; the
  component silently produces `<p>` on 403 with no contract test.
- **`mcp/web-ui/src/pages/Login.tsx:30`** — `navigate('/')` redirects to `/` which main.tsx
  redirects to `/library`. Two-hop redirect. Should be `navigate('/library', { replace: true })`.
- **`mcp/web-ui/src/lib/api.ts:43-50`** — Reads body twice when error (line 43 then line 53). If
  the body is large and the response is OK but `application/json` is malformed, the second read
  crashes with `body already read`. Minor.
- **`mcp/web-ui/src/pages/admin/ApprovalsPage.tsx:117`** — `Requested at {user.created_at ?? 'unknown'}`
  — renders the raw ISO string, not a `<RelativeTime>`. Other "created" fields use RelativeTime.
  Cross-page inconsistency.
- **`mcp/web-ui/src/components/ConversationList.tsx:154-187`** — `<Dialog>` re-renders on every
  pendingDeleteId change. OK.
- **`mcp/web-ui/src/components/AppShell.tsx:160`** — Dispatches a synthetic `metaKey: true` keydown
  to open the CommandPalette, but the listener in `CommandPalette.tsx:79-87` only fires on
  `metaKey || ctrlKey`. OK, but `ctrlKey: true` would also work; `metaKey: true` makes
  Linux/Windows users with `ctrl+k` muscle memory have to press both. Minor cross-platform
  bug.
- **`mcp/web-ui/src/pages/PrdDetailPage.tsx:96`** — `actions` slot only renders if `prd.source_url`
  is truthy; but the spec calls for "Open in Notion" only when source_url exists — correct.
- **`mcp/web-ui/src/pages/admin/RolesPage.tsx:148`** — `createMutation.mutate({ name: createName,
  description: '', permission_ids: createPermissions })` — the spec doesn't define what
  description is used for; passing empty string is unverified by backend.

---

## TOP 10 USER-VISIBLE GAPS (ranked by impact)

| # | Gap | File:line | Impact |
|---|-----|-----------|--------|
| 1 | **Invite button is a toast, not a flow** — admin can't onboard teammates | DirectoryPage.tsx:388 | Blocks the most basic admin action |
| 2 | **PRD Detail tabs missing** — status report claims Body/Metadata/History shipped; only Body exists | PrdDetailPage.tsx (whole file) | Spec regression; PMs can't see PRD history or conversations per PRD |
| 3 | **PRD Detail action menu missing** — no Copy ID, Copy Obsidian link, or Re-enrich (stub specced) | PrdDetailPage.tsx (whole file) | Daily friction: copy ID requires text-select, enrich re-run impossible |
| 4 | **StatusPage pipeline cards drop all real data** — only renders OK/Failed/Unknown, discards counts/timestamps/errors | StatusPage.tsx:147-159 | The page called out by Phase 3 §6 as the fix for the silent-fail bug now hides the actual data |
| 5 | **"Halted at stage: enrich" is not a timestamp** | StatusPage.tsx:117 | Misleading banner; PMs can't tell when the chain broke |
| 6 | **Recent PRDs in ⌘K is just top-of-library** | CommandPalette.tsx:89-98 | Trust signal mismatch: the label "Recent" is wrong; no real recents exist |
| 7 | **Library status filter has 3 of 7 enums** | LibraryPage.tsx:106-110 | PMs can't filter to `Done` / `In Review` / `In Progress` / `Not Started` even though cards render those badges |
| 8 | **Change password does not force re-login** | ChangePasswordDialog.tsx:58-66 | Spec ambiguity; possibly intentional, but the spec asked Duy to pick — no record of the call |
| 9 | **StatCard built but unused** | StatCard.tsx (whole file) | Dead code in the bundle; Phase 5's StatusPage redesign will probably want it |
| 10 | **Three admin pages use raw `<button>` instead of shadcn `<Button>`** | ApprovalsPage.tsx, RolesPage.tsx, SettingsPage.tsx | Spec violation: "no one-off styling"; focus rings/hover states diverge across admin pages |

---

## Recommended next actions (PM-facing)

1. Confirm with Duy: change-password auto sign-out (item 2.9) + Sources permission (`users.manage`
   vs `roles.manage`, item 6.2).
2. Phase 5 scope must include at minimum: gaps 1, 2, 3, 4, 6 — the rest are polish.
3. The status report (`.superpowers/sdd/phase4-status-2026-06-25.md`) over-claims: lines 20, 27,
   53 list features that are not actually shipped. Should be amended before Phase 5 planning so
   the next plan starts from the real state.
4. Bundle: `StatCard.tsx` is dead code; remove or use it in Phase 5.
