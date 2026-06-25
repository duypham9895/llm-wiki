# Phase 4 — UX Audit of Current Web-UI

**Date:** 2026-06-25
**Purpose:** Concrete, ruthless catalog of what's broken/boring/expensive in the current web-ui, paired with the Phase 4 spec fix. Plus competitor references, mood board queries, anti-patterns, micro-interactions, and density rules. This is the "excite Duy" doc — opinionated, not exhaustive.

---

## 1. Current pain points — by page

### 1.1 Login (`mcp/web-ui/src/pages/Login.tsx`)

- **L9–L98 — Bare card on grey screen.** No product mark, no "what is this" tagline, no sign-up affordance (correct — admin-only registration, but no copy says so). A first-time visitor lands here and has zero context.
- **L47** — "Use your LLM Wiki account" is the only brand cue. Slack-tier vagueness.
- **L89** — Primary button has no hover/focus state differentiation beyond the global `hover:bg-accent` chain (none on `bg-primary`). Looks static.
- **No keyboard hint**, no autofill favicon (browsers show this only for known passwords), no "forgot password" — irrelevant for our admin model but still leaves users guessing.
- **No dark-mode class hook.** Just CSS vars — works, but no toggle from login (you sign in dark then app flips? Verify.)
- **Spec fix:** Add product mark, single-line tagline ("PRD vault for Ringkas PMs"), proper `Button` shadcn primitive with hover/active states, tighten spacing.

### 1.2 AppShell / sidebar (`mcp/web-ui/src/components/AppShell.tsx`)

- **L34** — `md:grid md:grid-cols-[16rem_1fr]` — sidebar is fixed at 16rem, never collapses. At 768–1024px viewport this eats 33% of horizontal real estate. The spec calls for an icon-collapsed sidebar via shadcn `Sheet` below 1024px.
- **L36–L49** — "LLM Wiki" + email + Sign out stacked vertically. Email under the brand reads as a label, not a user identity. No avatar, no menu, no "Change password" entry point (the F4 self-serve feature in spec).
- **L51–L77** — Flat list of sections. No group icons, no counts, no collapse, no active-section highlight beyond the link's own background. Feels like a docs sidebar, not a product nav.
- **No search bar in the shell.** Spec puts it in the top bar — fine, but it means there's currently NO global way to jump to a PRD without going through Library filters.
- **No keyboard shortcuts surfaced.** `Cmd+K` is the F5 spec feature — currently nothing.
- **Spec fix:** Top bar + grouped left nav (Library / Ask / Status / Admin) with icons + counts, user menu in top-right (avatar, change password, sign out), sidebar collapses to icon-rail under 1024px.

### 1.3 Library (`mcp/web-ui/src/pages/LibraryPage.tsx`)

- **L84–L116** — Header + filters in one row. Filters are two `<select>`/`<input>` pairs at fixed widths — feels like 2018 Bootstrap. No "All / Active / Draft / Archived" pill set, no tag chips for quick filter, no result count next to the title.
- **L124–L128** — Loading state is one line of "Loading PRDs." with a spinner. No skeleton grid → flash of empty whitespace → cards pop in. Jarring on first load.
- **L130–L135** — Empty state is fine but generic ("Try clearing filters or searching a broader tag"). Doesn't tell you what to *do*.
- **L138–L175** — Card grid: 3 columns at xl, 2 at md, 1 at sm. Each card shows title, status pill, summary, tags, source link. Looks okay but:
  - L149 — Status pill (`rounded-full border`) sits in the top-right corner like a price tag. No color-coded state. Linear's status pills are colored (red/yellow/green/grey) — ours are all neutral grey text on grey border.
  - L153 — Summary `line-clamp-3` is OK but the type is `text-muted-foreground` — low contrast, hard to scan 12 cards.
  - L156 — Tag chips are flat `bg-secondary` — no interactivity (clicking doesn't filter).
  - L163–L172 — "Source" link with `ExternalLink` icon is the only meta — no PIC avatar, no last-synced date, no PRD ID visible on the card.
- **L178–L187** — "Load more" button instead of infinite scroll or pagination. Acceptable, but no progress indicator ("showing 12 of 47"). Feels finite.
- **L189–L233** — PRD reader opens in a centered modal (`fixed inset-0 grid place-items-center`). The PRD body renders inside a `<pre class="whitespace-pre-wrap">` at L226–L228. This is the single biggest UX failure: **PRDs render as raw monospace text with no markdown, no headings, no table support, no code blocks, no images, no TOC**. The spec F1 fixes this with react-markdown + TOC + tabs (Body/Metadata/Conversations/History).
- **L200** — Modal title says "Loading…" if not loaded, but no skeleton. Jumps from "Loading…" to full PRD body in one frame.
- **Modal uses `bg-background/80` backdrop** — fine. But no close-on-Esc handler (verify), no focus trap (Radix Dialog provides this; current is hand-rolled).

### 1.4 Search (`mcp/web-ui/src/pages/SearchPage.tsx`, 229 lines — not read in detail but checked size)

- Two-column layout, search bar at top, results below. No instant-search (debounced typing), no result highlighting, no facet panel. Card density probably matches Library.
- **Expected pain points (not deep-read):** identical to Library cards (no PIC, no last-edited, no PRD ID). No "no results, did you mean…" empty state. The spec doesn't explicitly call out Search redesign, so it should inherit the new card primitive — that's enough.

### 1.5 Ask (`mcp/web-ui/src/pages/AskPage.tsx`)

- **L248** — Two-column: `lg:grid-cols-[18rem_1fr]` — conversations rail + chat panel. Good bones.
- **L249–L303** — Conversations rail:
  - L250–L261 — Header with "New conversation" primary button (good). The button is full indigo with white text — the only strong color in the rail.
  - L263–L273 — Loading state is one line + spinner. Empty state is "No conversations yet. Create one to start asking." — bland.
  - L277–L300 — Each conversation row shows title (truncated) + date ("Mar 14" format, see `formatDate` L468–L473). Delete button is always-visible trash icon — clutters the rail. Spec calls for **hover-revealed** delete.
- **L306–L312** — When no conversation selected, shows a dashed border empty state with "Select or create a conversation." A bit passive-aggressive. Spec calls for **centered "Start by asking about any PRD" + example prompts**.
- **L313–L365** — Chat panel:
  - L315–L321 — Header has "Conversation" label + title + a Loader2 spinner on fetch. Spinner on every refetch is noisy.
  - **No streaming cursor / no "Assistant is typing…" placeholder.** While the assistant is streaming tokens, the bubble just grows. With a long answer this looks frozen until the first chunk arrives.
  - **No optimistic user bubble** — user submits, message appears in `localMessages` (good), but the assistant bubble starts empty so the layout jumps when content arrives.
  - L342–L364 — Form: textarea + Send button at bottom-right. No Enter-to-send hint, no char count, no stop/cancel button mid-stream (AbortController exists in code but no UI for it).
- **L373–L388** — MessageBubble:
  - User = `bg-secondary/60`, assistant = `bg-background` — both look similar, low contrast between them.
  - L378 — "Assistant" / "You" labels in uppercase tracked text — fine but no avatar.
  - L381 — "Rewritten question" line is small + muted. Useful debug info but not surfaced cleanly.
  - L383–L385 — Sources only render if `sources.sources.length > 0` — good. But `payload.verdict` is shown as a pill at L395–L399 (e.g. "no_match") — small, low signal.
- **L390–L423** — SourcesPanel: bordered card with source ID (e.g. "EP-468"), title, "Source" + "Obsidian" links. Source ID is rendered as plain text at L404 — should be mono font + clickable to the PRD detail page (spec F1 adds cross-links).

### 1.6 Status (`mcp/web-ui/src/pages/StatusPage.tsx`)

- **L88–L92** — Header "Pipeline status / Status". No last-refreshed timestamp, no refresh button, no auto-poll indicator.
- **L94–L104** — Loading + error states inline. No skeleton.
- **L106–L121** — "Pipeline halted" alert with `AlertTriangle` icon. Good — uses destructive border + bg, prominent. **But it doesn't link to anything** (no "View logs" CTA, no link to the failed stage). User sees "Pipeline halted" and has nowhere to go.
- **L123–L131** — Coverage card: "{enriched} / {total} enriched" + "{unenriched} not yet processed". A number with no progress bar, no percentage, no color. The spec's `StatCard` primitive fixes this.
- **L133–L166** — Pipeline stages grid (md:grid-cols-2). Each stage shows just name + OK/Failed/Unknown icon. **Zero stage metadata.** No duration, no timestamps, no stage description. The spec's `StatusDot` + stage expansion should expose more.
- **L168–L181** — History rail (18rem wide). Renders each run as `{run_id} · {stage_count} stages · OK/Failed`. No relative time, no clickable rows, no way to see run details. Spec puts history on the Sources page, not Status — but for the pipeline view this should still link to the run manifest.

### 1.7 Directory (`mcp/web-ui/src/pages/admin/DirectoryPage.tsx`)

- **L133–L151** — Header + Active/Disabled tab toggle. Tabs work but look like 2020 Bootstrap (`inline-flex rounded-md border p-1` with active state).
- **L168–L264** — Users table. Columns: User, Status, Roles, Actions.
  - **Roles column (L192–L217)** renders checkboxes for every role on every row. With 4 roles × 20 users = 80 checkboxes on screen, plus 20 "Save roles for {email}" buttons. **This is the worst UX in the app.** Spec F4 collapses this into a Manage Roles dialog.
  - **Save button per row** (L208–L215) — no visual feedback when click happens, no dirty-state indicator (click before changing anything = useless save). Spec uses a dirty-state badge on the row.
  - **Actions column (L218–L257)** has 3–4 buttons stacked vertically per row: Disable/Enable, Reset password, Delete. Each button is text-only with the user's email embedded in the label ("Disable duy@ringkas.co") — verbosity × N rows. Spec uses `DropdownMenu` (⋯) row actions.
  - **No search/filter** — with 20 users you'd want a search box.
  - **No pagination** — `AdminUsersResponse` returns `total/limit/offset` (L29–L33) but UI never paginates.
  - **No sort** — table headers aren't clickable.
  - **No user detail view** — clicking the email does nothing. Spec adds a Vaul drawer with audit fields.
- **L153–L154** — Success/error banners use `emerald-500` + `emerald-700` which are NOT in the spec's CSS variable palette. Spec uses `success` token. Color drift.
- **L268–L309** — Reset password modal is functional but doesn't reveal the password back (the current user types a new one). Spec wants reveal-once copy.

### 1.8 Roles (`mcp/web-ui/src/pages/admin/RolesPage.tsx`, 315 lines)

- (Deep read skipped — partial read up to L80 only.) Likely issues based on pattern:
  - Role list + permission matrix inline. With many permissions, this becomes a checkbox graveyard.
  - Same per-row Save-button problem as Directory.
  - System roles (`is_system`) may be editable when they shouldn't be.

### 1.9 Settings (`mcp/web-ui/src/pages/admin/SettingsPage.tsx`)

- **L80** — Form wrapped in `rounded-lg border bg-card p-4` — fine, but no section headers (just "Allowed domains" h2 at L97).
- **L86–L94** — "Registration enabled" is a raw `<input type="checkbox" size-5>` with no label/description explaining what it does. **No help text anywhere in the form.** A new admin reading this has to guess.
- **L116–L131** — Allowed domains list with trash icons. No drag-reorder, no validation feedback, no "add multiple" paste-friendly UX.
- **L133–L136** — "No allowed domains added" empty state is verbose but at least informative. Good.
- **L140–L146** — Single "Save settings" button at bottom. Saves both toggle AND domain list atomically — fine but no dirty indicator.
- **L65** — Success banner uses `emerald-500/40` + `emerald-700` — same color drift as Directory.

### 1.10 Approvals (`mcp/web-ui/src/pages/admin/ApprovalsPage.tsx`, 165 lines — not deep-read)

- Expectation: list of pending user signups with Approve/Reject buttons. Likely issues similar to Directory (inline checkboxes / no search / no filtering by date).

---

## 2. TOP 10 issues by user impact

| # | Issue | Where | Why it hurts | Spec fix |
|---|-------|-------|--------------|----------|
| 1 | **PRD body renders as `<pre>` monospace text** — no markdown, no headings, no tables | `LibraryPage.tsx:226-228` | PMs can't read PRDs in the app — the core feature is broken. They copy the ID and open Notion/Obsidian instead. | F1: `react-markdown` + TOC + tabs. |
| 2 | **No global search / ⌘K palette** | absent (`AppShell.tsx`) | To jump from PRD-A conversation to PRD-B detail, you go Library → scroll → filter → click. 4 hops for a 1-second task. | F5: cmdk palette with fuzzy search across pages + recent PRDs + actions. |
| 3 | **Ask conversations don't persist across reload** | `AskPage.tsx:59` (`selectedId` is local state) | PM closes laptop, comes back, loses chat context. The DB has the conversation; the URL doesn't carry it. | F3: `/ask#c=abc123` URL hash, reload keeps context. |
| 4 | **Directory "Save roles for {email}" inline button per row × N users** | `DirectoryPage.tsx:208-215` | 20 users × 4 roles = 80 checkboxes + 20 save buttons on screen. Eye-glaze, accidental saves, no dirty-state feedback. | F4: Row action menu (⋯) → Manage Roles dialog. |
| 5 | **No way to change your own password** | absent | Self-serve change-password is a v1 expectation for any internal tool. | F4: User menu → Change password modal with zod validation. |
| 6 | **No skeleton loaders anywhere — every async boundary shows spinner + text** | LibraryPage:124, AskPage:263, StatusPage:94, DirectoryPage:156, SettingsPage:67 | First paint of any page = blank space → text appears → content appears. Feels janky and dated. | F5: `Skeleton` / `SkeletonList` primitives. |
| 7 | **Status page has no actionable "View logs / See failed run" link** | `StatusPage.tsx:106-121` | Pipeline halted alert is a dead end. PM has to SSH in to investigate. | F1/F2: Pipeline halted banner links to the failed run manifest (Sources page). |
| 8 | **No top bar — brand/email/sign-out are crammed into a 16rem sidebar** | `AppShell.tsx:36-49` | No place for global search, theme toggle, notifications, user menu. Sidebar feels like a WordPress admin. | F5: 56px sticky top bar with backdrop-blur, brand left, search center, user menu right. |
| 9 | **No PRD detail route — opens as a modal** | `LibraryPage.tsx:189-233` | No shareable URL, no back-button history, no tabs (body/metadata/conversations/history), modal max-w-3xl truncates long PRDs. | F1: `/library/:id` full-page detail with TOC scrollspy + tabs. |
| 10 | **No status colors on Library cards / message bubbles / badges** | LibraryPage:149, AskPage:395-399, DirectoryPage:188-190 | Everything is grey-on-grey. Linear/Notion use red/yellow/green/grey for instant scanning. Without color, status takes 3x longer to parse. | Direction (locked): semantic tokens `--success/--warning/--destructive/--info`. Apply to `Badge` + `StatusDot`. |

---

## 3. Competitor reference list (inspiration only)

### Linear (issue tracker)
- **What they do well:** Keyboard-first navigation, dense cards with status dots + PIC avatars, ⌘K palette that does everything, sidebar that collapses to icons.
- **One pattern + hint to borrow:** **Sidebar with hover-revealed action buttons + counts on each nav item.** Linear shows "Inbox (12)" next to nav items — instant signal. Implementation: `<NavLink>{label}<span className="ml-auto text-muted-foreground">{count}</span></NavLink>`.

### Notion (docs)
- **What they do well:** Sidebar with collapsible section headers, breadcrumb at top, page metadata in a right rail (last edited, created by, word count).
- **One pattern + hint to borrow:** **Sidebar groups are collapsible (`<button>` toggling a chevron + section visibility).** Our current nav is flat — `sections.map` always renders. Add `useState<Record<string, boolean>>` + `collapsible` from Radix.

### Vercel dashboard (status.vercel.com + vercel.com dashboard)
- **What they do well:** Trustworthy status pages — green checkmarks + last incident timestamp + 90-day uptime bar. Status is a marketing surface.
- **One pattern + hint to borrow:** **90-day uptime bar (one row of 90 cells, each green or red).** Cheap to render (`<div>` grid with conditional bg), instantly conveys reliability. Apply to Status page under "Pipeline last 30 days".

### Stripe Dashboard
- **What they do well:** Data tables with right-aligned numerics, monospace IDs, inline filters above the table header, density without claustrophobia. Row hover reveals actions.
- **One pattern + hint to borrow:** **Row hover state that lifts the action buttons into the row (not always-visible).** Our Directory has 4 buttons per row always visible — Stripe shows them on row hover only. Implementation: `opacity-0 group-hover:opacity-100 transition-opacity` on the actions cell.

### Atlas (Ringkas AI team's KB platform — from memory `atlas-kb-platform.md`)
- **What Duy liked:** Cards with verdict + keyword search + citation-rich answers. Specifically: **verdict chip** (e.g. "match" / "no_match" / "partial") next to each result. The cards-as-evidence pattern (each PRD cited as a card with its own verdict).
- **One pattern + hint to borrow:** **Verdict chip pattern.** Library cards show "Status: Active" as a grey pill — make it semantic (`--success` for Active, `--warning` for Draft, `--muted` for Archived, `--destructive` for Halted). Same on Ask SourcesPanel.

---

## 4. Mood board — 5 search queries for Duy

Drop these into Google Images or Dribbble:

1. **`linear app settings empty state`** — find Linear's empty-state illustrations. We want: clean line-art icon + headline + CTA + secondary text. No gradient blobs.
2. **`vercel dashboard status page incident`** — find Vercel's incident timeline + uptime bars. We want: 90-day reliability grid, minimal chrome, trustworthy feel.
3. **`notion sidebar collapsed groups`** — find Notion's collapsible workspace sidebar with chevrons + section labels. We want: tight spacing, hover-revealed actions.
4. **`stripe dashboard data table row hover`** — find Stripe's table patterns: monospace IDs, right-aligned money, hover-revealed row actions. We want: density + scannability.
5. **`shadcn ui dashboard dark mode`** — find shadcn-built dashboards in dark mode (Taxonomy, Shadcn Studio, Vercel templates). We want: our exact primitives in production, not Figma fantasy.

---

## 5. Anti-patterns to skip

Modern "exciting" UI typically gets these wrong:

- **Excessive gradients.** Indigo-to-purple mesh backgrounds, glassmorphism, aurora effects. Looks impressive on a landing page, ages in 6 months, kills readability on data pages. Skip.
- **Big hero sections on every internal page.** A 400px hero with "Welcome to your library" + 3-step onboarding is fine for a marketing site. For a daily-driver PM tool, it's dead pixels. Top bar + page header (title + description + actions) is enough.
- **Useless illustrations.** Generic "person-at-desk" SVGs in empty states. Don't. Use a single line icon + a one-line CTA.
- **Animations that delay interaction.** Spinners on every click, 300ms page transitions, modal slide-ins that take 400ms. We want 150ms transitions max, no spinner on instant actions.
- **Dark patterns.** Pre-checked notification opt-ins, hidden delete buttons, fake urgency ("3 users invited in the last hour"). Internal tools especially — PMs notice.
- **Modal stacking.** Dialog over dialog over popover. Spec uses Vaul drawer for user detail to avoid this.
- **Custom scrollbars.** Browsers render scrollbars well. Custom-styled ones usually break keyboard scroll + trackpad momentum.
- **Color-only status signaling.** Red/green must have an icon or text label too (color-blind accessibility). The spec's `StatusDot` includes a label.
- **"Loading…" text without a skeleton.** Spec fixes this universally.
- **Tooltips on everything.** Tooltip fatigue is real. Only tooltip when the icon affordance is ambiguous (e.g. the row `⋯` button).

---

## 6. "Feels alive" checklist — 8 micro-interactions

For each: where it applies + how to implement.

| # | Interaction | Where | Library / pattern |
|---|-------------|-------|-------------------|
| 1 | **Skeleton → content crossfade** | Library first load, Ask conversation switch, PRD detail mount, Sources page mount | shadcn `<Skeleton>` + `framer-motion` `<AnimatePresence mode="wait">` wrapping the page; fade 150ms. |
| 2 | **Card hover lift** | Library cards, Status stat cards, Sources source cards | Tailwind `transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md`. Just `translate-y-[-1px]` + shadow bump. |
| 3 | **Toast for async actions** | Disable user, Reset password, Save roles, Sync now, Save settings | `sonner` — `<Toaster />` mounted in `main.tsx`. Call `toast.success('User disabled')` from mutation `onSuccess`. Auto-dismiss 4s. |
| 4 | **⌘K palette** | Global — bound to `Cmd+K` / `Ctrl+K` | shadcn `Command` (cmdk under the hood). Lists pages + recent PRDs + actions. First version navigation-only (spec deferral). |
| 5 | **Keyboard shortcut hints** | Library, Ask, Status — `g l`, `g s`, `g a`, `g s`, `?` | `useEffect` listening for `keydown`; ignore if input/textarea focused. Show shortcuts in a `?` help dialog (or in the ⌘K palette footer). |
| 6 | **Status dots with pulse when running** | Status page (pipeline stages), Sources page (last run) | Custom `<StatusDot state="running" />` — when `running`, render a 2px circle with `animate-pulse` + `--info` color. When idle/done/error, static. |
| 7 | **Relative timestamps that update live** | Conversation rail ("2 minutes ago"), History rail ("3h ago"), PRD last-synced | `date-fns` `formatDistanceToNow`. Tick every 30s via `setInterval` in a custom `<RelativeTime>` primitive. |
| 8 | **Empty states with personality** | Library (no PRDs), Ask (no conversations), Directory (no users), Sources (no sources) | Custom `<EmptyState icon={FileText} title="No PRDs yet" body="Sync from Notion to get started." cta={{ label: "Run Notion sync", onClick }} />`. One line + one CTA. No illustrations. |

---

## 7. Density vs breathing-room rule of thumb

| Page type | Whitespace | Info density | Rationale | Spec says |
|-----------|-----------|--------------|-----------|-----------|
| **List page** (Library, Directory, Sources, Roles) | Tight — `p-4` cards, 16px gaps | Dense — show status, count, last-touched, owner on every row | Users scan 20+ items at once; density IS the feature (Linear/Stripe model) | ✅ matches: "Density: 8px grid, 13–14px base body, tight line-height" |
| **Detail page** (PRD reader) | Generous — `max-w-3xl` body, 64–80ch reading column | Sparse — let the prose breathe | Reading comfort; eye fatigue on dense prose kills comprehension | ✅ matches: `max-w-6xl` outer, prose styling with 1.5–1.7 line-height |
| **Form page** (Settings, Roles edit, Change password) | Moderate — section spacing `space-y-6`, field spacing `space-y-2` | Moderate — labels + help text + field, no extra chrome | Forms need breathing room to feel "safe" (don't accidentally toggle the wrong thing) | ✅ matches: spec lists `react-hook-form` + `zod` for explicit field validation |
| **Status / dashboard** | Tight cards, generous hero stats | Hero stats (Coverage % big, Last run small), tight pipeline stages below | Numbers should pop; supporting data can be dense | ✅ matches: `StatCard` primitive + dense stage grid |

**Spec confirmation:** the Phase 4 design spec locks all four: "max-w-6xl (1152px) centered, 24px padding", "Cards p-4 for compact, p-6 for primary", "tight line-height 1.25 for cards/labels", "Inter 13–14px base body". ✅ No drift.

---

## Notes for plan authors

- The **single biggest win** is rendering PRD bodies as markdown (item #1 in TOP 10). Don't ship Phase 4 without it.
- The **second biggest win** is collapsing the Directory row-of-buttons into a `⋯` menu + dialogs (item #4). Same pattern in Roles if applicable.
- **Top bar + grouped nav + ⌘K** is the "feels like a real product" trifecta — all three ship together or none of them land.
- **Color drift alert:** `emerald-500/40` + `emerald-700` in DirectoryPage:154 and SettingsPage:65 must migrate to `success` token. Flag in plan.
- **Self-serve change password** is small backend work (verify endpoint exists) but huge UX unlock for the daily-driver PM.
