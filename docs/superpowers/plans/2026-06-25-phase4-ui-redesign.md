# Phase 4 — UI Redesign + Surface Existing Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the web-ui into a clean Linear/Notion-grade product using shadcn/ui + Tailwind + Radix, AND surface the four capabilities that have backend support but no UI today: PRD detail reader, Notion sync trigger + status, Ask conversation history, full user management + self-serve change password. Lock a design DNA (tokens + primitives + AppShell) that every later feature inherits.

**Architecture:** Standalone Vite app at `mcp/web-ui/`. All new primitives live under `src/components/ui/` (shadcn convention). Domain primitives (`PrdCard`, `MarkdownView`, `StatusDot`, `EmptyState`, `DataTable`, `RoleChip`) live under `src/components/`. New route `src/components/router.tsx` (or extended `main.tsx`) registers the 4 new pages. New backend additions are minimal: a `sources.py` router (3 routes) that wraps the existing sync CLI + reads existing manifests. Dark mode via CSS variables + Tailwind. ⌘K via cmdk. Motion via framer-motion.

**Tech Stack:** TypeScript, React 19, Vite, Tailwind v3.4 (pinned — see Risk 1), shadcn/ui (CLI-installed components), Radix (transitively), framer-motion, react-markdown, remark-gfm, rehype-raw, cmdk, sonner, vaul, zod, react-hook-form, date-fns. NO new state lib, router, or CSS-in-JS.

## Global Constraints

- **Test discipline:** every new primitive ships with a Vitest smoke test. Every new page ships with an MSW-backed test covering the happy path + the empty-state path.
- **No one-off styling.** If you need a new look, add a primitive to `src/components/ui/` or extend an existing one's variants.
- **No raw hex in components.** Only tokens (`bg-card`, `text-muted-foreground`, etc.) or `tailwindcss-animate` utilities.
- **Dark mode is non-optional.** Every primitive must render in both modes (visible in its demo).
- **Accessibility defaults come free from Radix.** Don't strip ARIA. Don't add `outline: none` without replacement.
- **Strict CSP-safe:** no inline scripts except the one in `index.html` that reads `localStorage` for theme (this is unavoidable for the dark-mode-no-flash pattern).
- **Senior Content Writer review** for every visible string before merge (per existing project rule).
- **Files in this plan are relative to `mcp/web-ui/` unless noted.**

---

## File Structure (new files marked ★)

```
mcp/web-ui/
├── index.html                        (edit: add theme inline script)
├── tailwind.config.js                ★ (replace with shadcn-compatible)
├── postcss.config.js                 (no change)
├── src/
│   ├── main.tsx                      (edit: add 2 new routes + theme provider)
│   ├── App.tsx                       (no change — still uses AppShell)
│   ├── styles/
│   │   └── globals.css               ★ (tokens + dark vars + shadcn base)
│   ├── lib/
│   │   ├── api.ts                    (no change)
│   │   ├── auth.tsx                  (no change)
│   │   ├── permissions.ts            (no change)
│   │   ├── utils.ts                  ★ (cn helper, already exists; extend)
│   │   ├── format.ts                 ★ (date-fns helpers, relative time)
│   │   └── theme.tsx                 ★ (theme provider + localStorage)
│   ├── components/
│   │   ├── AppShell.tsx              (rewrite: top bar + grouped left nav)
│   │   ├── AppShell.test.tsx         (rewrite for new nav)
│   │   ├── RequirePermission.tsx     (no change)
│   │   ├── CommandPalette.tsx        ★ (⌘K, cmdk)
│   │   ├── PageHeader.tsx            ★
│   │   ├── EmptyState.tsx            ★
│   │   ├── StatCard.tsx              ★
│   │   ├── StatusDot.tsx             ★
│   │   ├── RelativeTime.tsx          ★
│   │   ├── MarkdownView.tsx          ★ (react-markdown + shadcn prose)
│   │   ├── RoleChip.tsx              ★
│   │   ├── PrdCard.tsx               ★ (Library + Search use this)
│   │   ├── DataTable.tsx             ★ (tanstack-table + shadcn dropdown)
│   │   └── ui/                       ★ (shadcn primitives, ~18 files)
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── input.tsx
│   │       ├── textarea.tsx
│   │       ├── label.tsx
│   │       ├── badge.tsx
│   │       ├── avatar.tsx
│   │       ├── separator.tsx
│   │       ├── dialog.tsx
│   │       ├── sheet.tsx
│   │       ├── dropdown-menu.tsx
│   │       ├── tooltip.tsx
│   │       ├── tabs.tsx
│   │       ├── skeleton.tsx
│   │       ├── command.tsx
│   │       └── sonner.tsx
│   └── pages/
│       ├── Login.tsx                 (polish with new primitives)
│       ├── AskPage.tsx               (rewrite: rail + composer)
│       ├── AskPage.test.tsx          (rewrite)
│       ├── LibraryPage.tsx           (rewrite: grid + filters)
│       ├── LibraryPage.test.tsx      (rewrite)
│       ├── SearchPage.tsx            (rewrite: tabs + results)
│       ├── SearchPage.test.tsx       (rewrite)
│       ├── StatusPage.tsx            (rewrite: tabs + StatCards)
│       ├── StatusPage.test.tsx       (rewrite)
│       ├── PrdDetailPage.tsx         ★ (reader + tabs)
│       ├── PrdDetailPage.test.tsx    ★
│       ├── ChangePasswordDialog.tsx  ★ (modal triggered from user menu)
│       └── admin/
│           ├── DirectoryPage.tsx     (rewrite: DataTable + row menu)
│           ├── DirectoryPage.test.tsx (rewrite)
│           ├── RolesPage.tsx         (polish)
│           ├── SettingsPage.tsx      (polish)
│           ├── ApprovalsPage.tsx     (polish)
│           ├── SourcesPage.tsx       ★ (NEW — Notion sync UI)
│           └── SourcesPage.test.tsx  ★

mcp/prd_mcp/
└── web/
    ├── sources.py                    ★ (NEW: 3 routes)
    └── server.py                     (edit: mount sources router)
```

---

## Task 1 — Design DNA: tokens, primitives, layout (foundation, BLOCKS all features)

**Files:**
- Edit: `index.html`, `tailwind.config.js`
- Create: `src/styles/globals.css`, `src/lib/theme.tsx`, `src/lib/format.ts`
- Create: `src/components/ui/*` (15 shadcn primitives)
- Create: `src/components/PageHeader.tsx`, `EmptyState.tsx`, `StatCard.tsx`, `StatusDot.tsx`, `RelativeTime.tsx`, `CommandPalette.tsx`
- Rewrite: `src/components/AppShell.tsx`
- Edit: `src/main.tsx` (add ThemeProvider, CommandPaletteProvider, new routes placeholder)

### Step 1.1: Install dependencies

```bash
cd mcp/web-ui
pnpm add tailwindcss@^3.4 postcss autoprefixer \
  class-variance-authority clsx tailwind-merge tailwindcss-animate \
  @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-tooltip \
  @radix-ui/react-tabs @radix-ui/react-avatar @radix-ui/react-separator \
  @radix-ui/react-slot \
  lucide-react framer-motion \
  react-markdown remark-gfm rehype-raw \
  cmdk sonner vaul \
  zod react-hook-form @hookform/resolvers \
  date-fns @tanstack/react-table
pnpm add -D @types/react-table
```

Expected: lockfile updates, no errors. If `pnpm` not available, fall back to `npm`.

### Step 1.2: Configure Tailwind + tokens

- [ ] **Step 1.2.1:** Replace `tailwind.config.js` with shadcn-compatible config (CSS-vars theme, darkMode: 'class', content paths covering `src/**/*.{ts,tsx}`)
- [ ] **Step 1.2.2:** Create `src/styles/globals.css` with shadcn's base layer (`:root` + `.dark` CSS vars from spec §Design DNA → Color tokens), `@tailwind base; @tailwind components; @tailwind utilities;`, and a small `.prose` block for markdown rendering
- [ ] **Step 1.2.3:** Edit `src/main.tsx` to import `./styles/globals.css` instead of `./index.css` (and delete `index.css` after)

### Step 1.3: Add theme provider + dark-mode no-flash

- [ ] **Step 1.3.1:** Edit `index.html` `<head>`: add inline script BEFORE any module loads that reads `localStorage.theme` and applies `.dark` class to `<html>` (default to system preference if missing)
- [ ] **Step 1.3.2:** Create `src/lib/theme.tsx` exposing `ThemeProvider`, `useTheme()` returning `{theme, setTheme}`, persists to localStorage key `llm-wiki-theme`
- [ ] **Step 1.3.3:** Wrap `<App />` in `<ThemeProvider>` in `main.tsx`

### Step 1.4: Install shadcn primitives

For each primitive below, run `pnpm dlx shadcn@latest add <name>` (or copy-paste from shadcn docs into `src/components/ui/<name>.tsx`). All components must use `cn()` from `src/lib/utils.ts` (extend it to `clsx + tailwind-merge`).

- [ ] button, card, input, textarea, label, badge, avatar, separator, dialog, sheet, dropdown-menu, tooltip, tabs, skeleton, command, sonner

Verify: each file imports from `@radix-ui/*` (not raw HTML), uses `cva` for variants, exports a typed component.

### Step 1.5: Domain primitives

- [ ] **Step 1.5.1:** Create `src/lib/utils.ts` if missing — exports `cn(...inputs)` = `twMerge(clsx(inputs))`
- [ ] **Step 1.5.2:** Create `src/lib/format.ts` — exports `relativeTime(date: Date | string): string` using date-fns `formatDistanceToNow` + `intlFormat` for full timestamp
- [ ] **Step 1.5.3:** `src/components/StatusDot.tsx` — props `{status: 'idle'|'running'|'ok'|'error'|'warning', label?: string}`, renders a 8px colored dot + optional label. Variants via cva.
- [ ] **Step 1.5.4:** `src/components/RelativeTime.tsx` — props `{date, withTooltip?: boolean}`, renders relative time, full timestamp on hover
- [ ] **Step 1.5.5:** `src/components/EmptyState.tsx` — props `{icon?: LucideIcon, title, description?, action?: {label, onClick}}`, centered with subdued illustration area
- [ ] **Step 1.5.6:** `src/components/PageHeader.tsx` — props `{title, description?, actions?: ReactNode}`, used at top of every page
- [ ] **Step 1.5.7:** `src/components/StatCard.tsx` — props `{label, value, delta?, intent?: 'success'|'warning'|'error'|'neutral'}`, renders a label / big number / optional delta arrow
- [ ] **Step 1.5.8:** `src/components/RoleChip.tsx` — props `{role: string}`, renders a Badge with color hashed from role name (deterministic across reloads)
- [ ] **Step 1.5.9:** `src/components/MarkdownView.tsx` — wraps react-markdown with remark-gfm + rehype-raw + shadcn prose styles. Used by PrdDetailPage.

Each primitive ships with a one-file Vitest smoke test that imports + renders (no assertions beyond "doesn't throw"). Add to existing `src/test/util.tsx` render helper.

### Step 1.6: ⌘K command palette

- [ ] **Step 1.6.1:** `src/components/CommandPalette.tsx` — uses shadcn `Command` (cmdk under the hood). Lists: pages (Library, Search, Ask, Status, Admin sections), recent PRDs (last 10 from `useQuery(['recent-prds'])`), quick actions (Run Notion sync — gated on perm). Fuzzy search across all items. Opens on `Cmd+K`/`Ctrl+K`, closes on Esc or outside click.
- [ ] **Step 1.6.2:** Add `<CommandPalette />` to `AppShell.tsx` so it mounts once per session

### Step 1.7: AppShell rebuild

- [ ] **Step 1.7.1:** Rewrite `AppShell.tsx`:
  - Top bar (sticky, h-14): app mark + workspace label · centered search trigger (opens CommandPalette) · right cluster: theme toggle, notifications bell (placeholder, no-op), user menu (DropdownMenu: "Change password" → opens `ChangePasswordDialog`, "Sign out")
  - Left nav: grouped sections from spec §IA, each section a `<nav>` with header + items. Active state = `bg-accent text-accent-foreground`. Collapse to icons-only Sheet at <1024px.
  - Use `<Outlet />` for content
- [ ] **Step 1.7.2:** Update `AppShell.test.tsx` to assert: each section renders, active state highlights, theme toggle exists

### Step 1.8: Wire main.tsx

- [ ] **Step 1.8.1:** Register `<Toaster />` from sonner (top-right, rich colors)
- [ ] **Step 1.8.2:** Add placeholder routes for `/library/:id`, `/admin/sources` that render an `EmptyState` saying "Coming in this phase — see design spec §F1/F2". (Replaced by Tasks 2 + 5.)

---

## Task 2 — PRD Detail view (`/library/:id`)

**Files:**
- Create: `src/pages/PrdDetailPage.tsx`, `PrdDetailPage.test.tsx`
- Create: `src/components/PrdCard.tsx` (reused by Library + Search)
- Edit: `src/pages/LibraryPage.tsx`, `SearchPage.tsx` to use PrdCard and link to `/library/:id`
- Edit: `src/main.tsx` to register `/library/:id` route

### Step 2.1: PrdCard component

- [ ] **Step 2.1.1:** `src/components/PrdCard.tsx` — props `{prd: {id, title, status, tags, summary, source_url, last_edited}}`, renders a `<Link to={`/library/${id}`}>` wrapping a Card: title (line-clamp-2), summary (line-clamp-3), tags as Badge cluster, footer with status badge + RelativeTime
- [ ] **Step 2.1.2:** Hover lift animation: `transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-md`

### Step 2.2: Library + Search cards

- [ ] **Step 2.2.1:** Refactor `LibraryPage.tsx` to use `PrdCard` in a responsive grid (`grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4`)
- [ ] **Step 2.2.2:** Refactor `SearchPage.tsx` results similarly
- [ ] **Step 2.2.3:** Add filter chips at top of Library (status, tags) using existing API query params

### Step 2.3: PrdDetailPage

- [ ] **Step 2.3.1:** `PrdDetailPage.tsx`:
  - `useParams()` → `id`
  - `useQuery(['prd', id], () => apiFetch(\`/prd/\${id}\`))`
  - Loading: `Skeleton` shaped like the layout
  - Not found: `EmptyState` with "Back to Library" CTA
  - Layout:
    - `PageHeader` (title + status badge + tag cluster + actions menu `⋯` with Copy ID, Copy Obsidian link, Open in Notion)
    - Metadata strip: PIC · Notion link · Synced relative time
    - Two-column body: `<aside>` TOC (auto-extracted from markdown) + `<MarkdownView>` body
    - `<Tabs>` below body: Body · Metadata · Conversations · History (each lazy-loaded)
- [ ] **Step 2.3.2:** TOC: render `##` and `###` from markdown headings into a sidebar list with anchor links + scrollspy via IntersectionObserver
- [ ] **Step 2.3.3:** Register route in `main.tsx`: `<Route path="library/:id" element={<PrdDetailPage />} />`
- [ ] **Step 2.3.4:** Test: renders title, body markdown, TOC items, metadata strip; renders EmptyState on 404

---

## Task 3 — Notion Sync UI (`/admin/sources`)

**Files (frontend):**
- Create: `src/pages/admin/SourcesPage.tsx`, `SourcesPage.test.tsx`
- Edit: `src/components/AppShell.tsx` — add Admin → Sources link (when `users.manage` perm)
- Edit: `src/main.tsx` — register route

**Files (backend):**
- Create: `mcp/prd_mcp/web/sources.py`
- Edit: `mcp/prd_mcp/server.py` — mount router

### Step 3.1: Backend — sources router

- [ ] **Step 3.1.1:** `mcp/prd_mcp/web/sources.py`:
  - `GET /admin/sources` → `[{id, kind, label, status, last_run_at, last_counts, next_run_at, schedule}]`
    - Reads `vault/.manifests/sync/*.json`, picks newest per source
  - `GET /admin/sources/{id}/runs` → last 10 manifest entries for that source
  - `POST /admin/sources/{id}/run` → returns `{run_id}` immediately, kicks off `asyncio.create_subprocess_exec('npm', 'run', 'sync', cwd='/app', env=...)` with VAULT_PATH + NOTION_TOKEN from keychain, captures stdout, writes fresh manifest. Per-source asyncio.Lock serializes.
  - `GET /admin/sources/{id}/runs/{run_id}` → returns the run state (`running` | `ok` | `error` | `timeout`)
- [ ] **Step 3.1.2:** All routes gated by `users.manage` permission
- [ ] **Step 3.1.3:** Mount in `server.py`: `app.include_router(sources.router, prefix='/api', tags=['admin'])`
- [ ] **Step 3.1.4:** Unit test: 1) manifest reading returns last 10 in order; 2) concurrent `run` calls are serialized

### Step 3.2: Frontend — SourcesPage

- [ ] **Step 3.2.1:** `SourcesPage.tsx`:
  - `useQuery(['sources'])` polls every 5s while any source is `running`, else 30s
  - `useQuery(['source-runs', id])` for recent runs list
  - PageHeader: "Sources" + description "Connect external systems that feed your PRD vault."
  - One `<Card>` per source:
    - Top row: `StatusDot` + name + "Run now" button (or spinner + "Running 0:14" elapsed if running)
    - Subtitle: type + identifier (e.g., "Database: Product Backlog (3f6ac861…)")
    - Divider
    - "Last run: 2h ago · ok · synced 4 skipped 0 archived 0 errors 0 · Next run: in 4h"
    - "Recent runs" mini-table (top 5)
- [ ] **Step 3.2.2:** "Run now" flow:
  - `useMutation` calls `POST /admin/sources/{id}/run`
  - On click: open Dialog "This will write to the vault and re-index Chroma. Continue?"
  - On confirm: fire mutation; on success toast "Sync started"; invalidate `['sources']`
- [ ] **Step 3.2.3:** Empty state: when no sources configured, show "No sources configured yet" + link to docs
- [ ] **Step 3.2.4:** Test: renders a source with last run; renders "Run now" confirm dialog; handles running state (button replaced with spinner)

---

## Task 4 — Conversation history in Ask (`/ask`)

**Files:**
- Rewrite: `src/pages/AskPage.tsx`, `AskPage.test.tsx`

### Step 4.1: Layout

- [ ] **Step 4.1.1:** New two-column layout: left rail (256px) + main chat area
- [ ] **Step 4.1.2:** Left rail:
  - "New chat" button at top (creates new conversation via `POST`, navigates to `/ask#c={id}`)
  - Conversation list (`useQuery(['conversations'])`): title = first user message truncated to 60 chars, RelativeTime, hover-revealed delete icon
  - Active conversation highlighted (from URL hash)
  - Empty state when no conversations: "Your Ask history will appear here"
- [ ] **Step 4.1.3:** Main area:
  - `useQuery(['conversation', cid])` loads messages
  - If no cid: `EmptyState` with example prompts ("What's our onboarding flow?", "Summarize EP-468")
  - Otherwise: message list (assistant messages expandable to show sources) + composer at bottom
  - Composer: textarea + Send button, Enter to send, Shift+Enter for newline

### Step 4.2: URL hash persistence

- [ ] **Step 4.2.1:** On conversation select: `history.replaceState(null, '', \`/ask#c=\${cid}\`)`
- [ ] **Step 4.2.2:** On mount: read `location.hash`, parse `c=`, set as active
- [ ] **Step 4.2.3:** On "New chat": clear hash, focus composer

### Step 4.3: Delete conversation

- [ ] **Step 4.3.1:** `useMutation` calls `DELETE /chat/conversations/{cid}`
- [ ] **Step 4.3.2:** On click: Dialog "Delete this conversation? This cannot be undone."
- [ ] **Step 4.3.3:** On confirm: optimistic removal from list, rollback on error with toast

### Step 4.4: Tests

- [ ] **Step 4.4.1:** Renders empty state when no conversations
- [ ] **Step 4.4.2:** Renders conversation list from API
- [ ] **Step 4.4.3:** Clicking "New chat" creates + navigates
- [ ] **Step 4.4.4:** Clicking delete opens confirm + removes after confirm

---

## Task 5 — Full user management + self-serve change password

**Files:**
- Rewrite: `src/pages/admin/DirectoryPage.tsx`, `DirectoryPage.test.tsx`
- Create: `src/components/DataTable.tsx`
- Create: `src/pages/ChangePasswordDialog.tsx`
- Edit: `src/components/AppShell.tsx` (user menu → Change password)

### Step 5.1: DataTable primitive

- [ ] **Step 5.1.1:** `src/components/DataTable.tsx`:
  - Props: `columns: ColumnDef[]`, `data: T[]`, `onRowClick?: (row) => void`, `emptyState?: ReactNode`
  - Uses `@tanstack/react-table` for sort + pagination
  - shadcn `Table` for markup, `DropdownMenu` per row for actions
  - Selection state optional (skip for now)
- [ ] **Step 5.1.2:** Smoke test: renders headers, renders rows, sort toggles

### Step 5.2: DirectoryPage

- [ ] **Step 5.2.1:** `useQuery(['users'])` for list, `useQuery(['permissions'])` for role-assignment dialog
- [ ] **Step 5.2.2:** Top bar: search input (client-side filter on name/email), "+ Invite" button (placeholder, no-op)
- [ ] **Step 5.2.3:** DataTable columns: Name (with avatar + email), Roles (RoleChip cluster), Status (Badge), Last login (RelativeTime), Actions (DropdownMenu)
- [ ] **Step 5.2.4:** Row click → opens Vaul Sheet drawer (right) showing user detail + editable role assignment
- [ ] **Step 5.2.5:** Row action menu:
  - Reset password → Dialog "A temporary password will be shown once. Copy it now." → `POST /admin/users/{id}/reset-password` → Dialog reveals password + Copy button + "Done" closes
  - Disable/Enable → instant mutation + optimistic status update + toast
  - Delete → Dialog with typed email confirm → `DELETE /admin/users/{id}`
- [ ] **Step 5.2.6:** Role assignment: `useMutation` calls `PUT /admin/users/{id}/roles` with selected role IDs; closes drawer on success

### Step 5.3: ChangePasswordDialog

- [ ] **Step 5.3.1:** Triggered from user menu in AppShell
- [ ] **Step 5.3.2:** Form fields: Current password · New password · Confirm password
- [ ] **Step 5.3.3:** zod schema: `current` required; `new` min 8 chars, must differ from `current`; `confirm` matches `new`
- [ ] **Step 5.3.4:** react-hook-form with `zodResolver`
- [ ] **Step 5.3.5:** On submit: `POST /auth/change-password`; success → toast + close + (if backend invalidates session) sign out
- [ ] **Step 5.3.6:** Error rendering: 401 → "Current password is incorrect" inline error; 400 → field-level

### Step 5.4: Tests

- [ ] **Step 5.4.1:** DirectoryPage: renders users, sort toggles, row menu opens, reset-password dialog renders the temp password on success, role assignment updates chip
- [ ] **Step 5.4.2:** ChangePasswordDialog: validation errors, submit happy path, 401 error inline

---

## Task 6 — Polish (cross-cutting)

**Files:**
- Create: `src/components/KbdHint.tsx` (small `<kbd>` styled component)
- Edit: every page to use `PageHeader`, `EmptyState`, motion

### Step 6.1: Motion

- [ ] **Step 6.1.1:** Add `<AnimatePresence mode="wait">` around `<Outlet />` in `AppShell.tsx`; page transitions = fade + 4px slide-up, 150ms
- [ ] **Step 6.1.2:** List items in Library, Search, Ask history, Directory: stagger entrance via framer-motion `motion.div` with `initial`/`animate` + `transition.delay = index * 0.03`
- [ ] **Step 6.1.3:** Cards: `whileHover={{ y: -1 }}` + `transition={{ duration: 0.15 }}`

### Step 6.2: Empty states (audit)

- [ ] **Step 6.2.1:** LibraryPage: no PRDs → "No PRDs yet" + "Run Notion sync" CTA (gated)
- [ ] **Step 6.2.2:** SearchPage: no results → "No matches for `{q}`" + "Try a broader query"
- [ ] **Step 6.2.3:** AskPage (no conversations) → friendly state with 3 example prompts as buttons
- [ ] **Step 6.2.4:** DirectoryPage: no users → "No users yet"
- [ ] **Step 6.2.5:** SourcesPage: no sources → "No sources configured"

### Step 6.3: Keyboard shortcuts

- [ ] **Step 6.3.1:** Implement via `useEffect` listening on `document`:
  - `Cmd+K` / `Ctrl+K` → open CommandPalette
  - `g l` → /library, `g s` → /search, `g a` → /ask, `g t` → /status (using `g` prefix avoids collisions)
  - `?` → open shortcut help Dialog
- [ ] **Step 6.3.2:** CommandPalette shows shortcut hints inline (e.g., `Library  G L`)

### Step 6.4: Accessibility pass

- [ ] **Step 6.4.1:** Skip-to-content link as first focusable in AppShell
- [ ] **Step 6.4.2:** All interactive elements have visible focus rings (`focus-visible:ring-2 focus-visible:ring-ring`)
- [ ] **Step 6.4.3:** Honor `prefers-reduced-motion`: in motion components, check `useReducedMotion()` and skip animations

### Step 6.5: Content review

- [ ] **Step 6.5.1:** Hand every new visible string to Senior Content Writer agent for tone/clarity pass
- [ ] **Step 6.5.2:** Verify empty states, error states, button labels read naturally in English

---

## Task 7 — Verify (e2e, build, deploy, screenshots)

### Step 7.1: Local verification

- [ ] **Step 7.1.1:** `pnpm typecheck` clean
- [ ] **Step 7.1.2:** `pnpm test` — all green, including new page tests + primitive smokes
- [ ] **Step 7.1.3:** `pnpm build` — bundle under target (warning if any chunk > 500kb)
- [ ] **Step 7.1.4:** Run app locally against staging backend; click through every new flow

### Step 7.2: Deploy

- [ ] **Step 7.2.1:** Build + push web-ui container (already in `mcp/deploy/docker-compose.yml` as `webui` service)
- [ ] **Step 7.2.2:** On VPS (`ssh openclaw`):
  - `cd /opt/llm-wiki && docker compose pull webui app`
  - `docker compose up -d webui app`
  - Wait for health checks; tail logs

### Step 7.3: End-to-end smoke via Chrome DevTools MCP

- [ ] **Step 7.3.1:** Login as admin → land on /library
- [ ] **Step 7.3.2:** Click a PRD card → detail page renders with body, TOC, metadata
- [ ] **Step 7.3.3:** ⌘K → palette opens, fuzzy search "library" works, jump to /search
- [ ] **Step 7.3.4:** /ask → start conversation → message streams → appears in left rail → reload → still there
- [ ] **Step 7.3.5:** /admin/directory → row menu opens → reset password dialog → reveals temp password
- [ ] **Step 7.3.6:** User menu → Change password → submit with wrong current → inline error → submit valid → toast
- [ ] **Step 7.3.7:** /admin/sources → Run now confirm dialog → spinner + "Running 0:14" → completion toast → recent run shows new entry
- [ ] **Step 7.3.8:** Theme toggle → both modes render cleanly → reload → no flash

### Step 7.4: Capture

- [ ] **Step 7.4.1:** Screenshot every page in light + dark mode; save under `docs/superpowers/plans/2026-06-25-phase4-screenshots/`
- [ ] **Step 7.4.2:** Note any regressions in `task-7-report.md`

---

## Scope Cuts (use if slipping)

- **F2 Notion Sync → read-only first:** drop "Run now" mutation + polling; show only last-run status. Saves 1 backend file + most of SourcesPage mutation logic.
- **F3 Conversation history → dropdown instead of rail:** replace left rail with a top dropdown of conversations. Saves layout work, keeps CRUD.
- **F4 User mgmt → no drawer:** actions only via row menu, no detail drawer. Saves ~half a day.
- **F5 Polish → skip dark mode first cut:** ship light only, add dark in Phase 4.5.
- **⌘K → navigation only first:** drop "Run Notion sync" action from palette until Phase 4.5.

## Verification Criteria (Phase 4 done = all true)

- [ ] Design DNA: every page renders in light + dark with no flash on reload
- [ ] All 15 shadcn primitives installed, themed, with smoke tests
- [ ] Library cards link to detail; detail page renders markdown + TOC + tabs
- [ ] Notion sync UI shows last-run status; "Run now" works end-to-end (or scope-cut to read-only)
- [ ] Ask page: conversation history visible, persists across reload, delete works
- [ ] Directory: row menu actions all work; self-serve change password works
- [ ] ⌘K palette: navigation + page jump + recent PRDs work
- [ ] Vitest suite green, TypeScript clean, build green
- [ ] Deployed to VPS, smoke-tested via Chrome DevTools MCP
- [ ] Before/after screenshots captured
