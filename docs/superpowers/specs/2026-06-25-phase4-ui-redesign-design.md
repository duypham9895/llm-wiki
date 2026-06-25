# Phase 4 — UI Redesign + Surface Existing Capabilities (Design Spec)

**Date:** 2026-06-25
**Status:** Draft (pre-review)
**Author:** brainstorm session
**Related:**
- `2026-06-20-web-dashboard-design.md` (Phase 3 frontend — current UI)
- `2026-06-20-auth-user-management-design.md` (Phase 2 backend — auth/RBAC contracts)
- `2026-06-17-notion-obsidian-prd-sync-design.md` (sync CLI we'll now surface)
- `2026-06-19-llm-enrichment-design.md` (enrichment CLI surfaced via Status)

## Goal

Reskin the web-ui into a clean Linear/Notion-grade product (single design DNA applied everywhere) AND surface the capabilities that exist in the backend but have no UI today: PRD detail reader, Notion sync trigger, Ask conversation history, full user management, self-serve change password. Make the result something a PM team is *excited* to open in a tab.

## Non-Goals (v1)

- Multi-tenant org model (single Ringkas workspace).
- Public/sharable PRD links (login required for everything).
- Mobile-first redesign (we hit 360px gracefully but the IA is desktop-primary).
- Theme marketplace / white-label theming.
- Drag-and-drop board views (PRDs are documents, not cards-on-kanban).
- Comments, mentions, presence, real-time collab.
- Migration to a different meta-framework (Next.js, Remix). Stay on Vite + react-router.

## Audience

1–3 PMs as daily drivers. Density and keyboard-first matter more than onboarding hand-holding. Internal Ringkas team (5–20) as occasional readers; nav must be self-explanatory but not patronizing.

## Direction (Locked)

Clean SaaS, Linear/Notion-vibe:
- Neutral greys (one accent: indigo `#5E6AD2`-ish, swap-able)
- Sharp typography: Inter (UI), JetBrains Mono (code/IDs)
- Density: 8px grid, 13–14px base body, tight line-height
- Subtle motion only (150–200ms ease-out, no bounce)
- Dark mode is first-class (CSS variables, no flicker)

## Tech Foundation (Locked)

- **shadcn/ui + Tailwind + Radix** — components live in repo, owned by us, themable
- **framer-motion** — page + list transitions only
- **react-markdown + remark-gfm + rehype-raw** — PRD body rendering
- **cmdk** — ⌘K command palette (shadcn already uses it)
- **lucide-react** — icons (already installed)
- **zod** — form/runtime schema validation
- **react-hook-form** — for change-password + role-edit forms
- **sonner** — toast notifications (replaces custom)
- **vaul** — drawer primitive (user detail)
- **date-fns** — relative timestamps

NO new state library (react-query stays). NO new router (react-router-dom stays). NO CSS-in-JS (Tailwind stays).

## Design DNA (the source of truth)

### Color tokens (CSS vars in `src/styles/globals.css`)

```css
:root {
  /* Surfaces (light) */
  --background: 0 0% 100%;        /* page bg */
  --foreground: 240 10% 4%;       /* body text */
  --card: 0 0% 100%;
  --card-foreground: 240 10% 4%;
  --muted: 240 5% 96%;
  --muted-foreground: 240 4% 46%;
  --border: 240 6% 90%;
  --input: 240 6% 90%;
  --ring: 238 75% 65%;            /* indigo focus ring */

  /* Brand */
  --primary: 238 75% 65%;         /* indigo #5E6AD2-ish */
  --primary-foreground: 0 0% 100%;

  /* Semantic */
  --success: 142 71% 45%;
  --warning: 38 92% 50%;
  --destructive: 0 84% 60%;
  --info: 199 89% 48%;
}

.dark {
  --background: 240 10% 4%;
  --foreground: 0 0% 98%;
  --card: 240 6% 7%;
  --card-foreground: 0 0% 98%;
  --muted: 240 4% 12%;
  --muted-foreground: 240 5% 64%;
  --border: 240 4% 16%;
  --input: 240 4% 16%;

  --primary: 238 75% 70%;
  --primary-foreground: 240 10% 4%;
}
```

Every primitive references `bg-background`, `text-foreground`, `bg-card`, `border-border`, etc. — never raw hex.

### Typography

- Font: Inter (loaded via `<link>` in `index.html`, woff2 subset)
- Mono: JetBrains Mono (for PRD IDs, code)
- Scale (Tailwind `text-*`): `xs 12px · sm 13px · base 14px · lg 16px · xl 18px · 2xl 20px · 3xl 24px · 4xl 30px`
- Headings: `tracking-tight`, weights 600/700 only
- Body line-height: 1.5; tight line-height (1.25) for cards/labels

### Radius / Shadow / Motion

- Radius: `--radius: 0.5rem` (default), sm 0.375, lg 0.75
- Shadow scale: subtle (`shadow-sm` for cards, `shadow-md` for popovers, `shadow-lg` for modals) — no glow effects
- Motion: `--transition: 150ms cubic-bezier(0.4, 0, 0.2, 1)` — applied via Tailwind `transition-colors duration-150`

### Spacing / Layout

- Page max-width: `max-w-6xl` (1152px), centered, 24px padding
- Cards: `p-4` for compact, `p-6` for primary
- Left nav width: `14rem` collapsed icon-only at <1024px via shadcn `Sheet`
- Top bar: 56px tall, sticky, `border-b bg-background/95 backdrop-blur`

## Information Architecture (Locked)

### Top bar (every authed page)
- Left: app mark + current workspace label
- Center: global search trigger (clicking opens ⌘K palette)
- Right: theme toggle, notifications (placeholder bell for now), user menu (email, "Change password", "Sign out")

### Left nav — grouped sections (replaces single list)
- **Library**
  - Browse (→ /library)
  - Search (→ /search)
  - Detail pages rendered inside this section's outlet (NOT new top-level routes)
- **Ask**
  - New chat (→ /ask)
  - Conversations (inline list under "Ask", not a separate route)
- **Status**
  - Pipeline (→ /status)
  - Coverage (sub-tab on Status page)
- **Admin** (hidden unless permission)
  - Approvals (→ /admin/approvals)
  - Users (→ /admin/directory)
  - Roles (→ /admin/roles)
  - Settings (→ /admin/settings)
  - **NEW** Sources (→ /admin/sources) — Notion sync + future

### Route map
```
/                       → redirect /library
/library                → LibraryPage (grid of PRD cards, filters)
/library/:id            → PrdDetailPage (full reader)
/search                 → SearchPage (results, two modes)
/ask                    → AskPage (chat with conversation rail)
/status                 → StatusPage (pipeline + coverage tabs)
/admin/approvals        → ApprovalsPage
/admin/directory        → DirectoryPage (users table + actions)
/admin/roles            → RolesPage
/admin/settings         → SettingsPage
/admin/sources          → SourcesPage (NEW)
/change-password        → ChangePasswordPage (self-serve, modal in user menu preferred)
*                       → 404 → redirect /library
```

## Component Inventory (the design DNA primitives)

Built once in `src/components/ui/` (shadcn convention). All features consume from this list — no one-off styling.

| Primitive | Source | Purpose |
|---|---|---|
| `Button` | shadcn | variants: default, secondary, ghost, outline, destructive; sizes sm/default/lg/icon |
| `Card` + `CardHeader/Content/Footer` | shadcn | PRD cards, source cards, stat cards |
| `Input` + `Textarea` | shadcn | search, forms |
| `Label` | shadcn | form labels |
| `Badge` | shadcn | status pills (Not Started/In Progress/Done/Archived) |
| `Avatar` | shadcn | PIC avatars |
| `Separator` | shadcn | nav dividers |
| `Dialog` | shadcn | confirmations, sync trigger |
| `Sheet` | shadcn | user detail drawer (mobile) |
| `DropdownMenu` | shadcn | user menu, row actions |
| `Tooltip` | shadcn | icon affordances |
| `Toast` (sonner) | shadcn | async action feedback |
| `Tabs` | shadcn | Status (pipeline/coverage), PRD detail (body/metadata/history) |
| `Command` (⌘K) | shadcn | global palette |
| `Skeleton` | shadcn | loading states |
| `SkeletonList` | custom | N skeletons in a column |
| `EmptyState` | custom | icon + title + body + CTA |
| `StatCard` | custom | number + label + delta (for Status) |
| `DataTable` | custom | sortable, paginated, row-action menu (tanstack-table under the hood) |
| `PageHeader` | custom | title + description + actions slot |
| `StatusDot` | custom | colored dot + label (idle/running/error) |
| `RelativeTime` | custom | "2 hours ago" via date-fns |
| `MarkdownView` | custom | react-markdown wrapper with prose styles |
| `RoleChip` | custom | role badge with color from role name hash |

All primitive files include a tiny demo in their header comment so future contributors can copy the API.

## Feature Designs

### F1. PRD Detail view (`/library/:id`)

```
┌───────────────────────────────────────────────────────────────┐
│ ← Library    EP-468 · Onboarding Redesign        [⌘K] [👤]  │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  [In Review]  [growth] [ux] [onboarding]                     │
│                                                               │
│  Onboarding Redesign                                  ⋯       │
│  Reduce time-to-first-PRD from 14d to 5d by Q3.              │
│                                                               │
│  PIC: Duy Pham  ·  Notion ↗  ·  Synced 2h ago                │
│  ────────────────────────────────────────────────────────    │
│                                                               │
│  ┌────────────────────┐  ┌─────────────────────────────┐    │
│  │ TOC                │  │ ## Background               │    │
│  │ ▸ Background       │  │   We currently require PMs… │    │
│  │ ▸ Goals            │  │                             │    │
│  │ ▸ Scope            │  │ ## Goals                    │    │
│  │ ▸ Out of scope     │  │   1. Reduce time-to-first…  │    │
│  │ ▸ Risks            │  │                             │    │
│  └────────────────────┘  └─────────────────────────────┘    │
│                                                               │
│  [Tabs: Body · Metadata · Conversations · History]           │
└───────────────────────────────────────────────────────────────┘
```

- **Data:** `GET /api/prd/{id}` (exists)
- **Markdown rendering:** react-markdown + remark-gfm; tables, code, checkboxes render natively
- **TOC:** auto-extract `h2/h3` from rendered tree, scrollspy
- **Tabs:** Body (default) · Metadata (status/tags/PIC/source/created/last_edited) · Conversations (filtered list where this PRD was cited) · History (last 5 sync runs that touched this PRD from manifests)
- **Actions menu (`⋯`):** Copy ID · Copy Obsidian link · Open in Notion (if `source_url`) · Re-run enrichment (admin only)
- **Not found:** dedicated empty state with "Back to Library" CTA

### F2. Notion Sync UI (`/admin/sources`)

```
┌───────────────────────────────────────────────────────────────┐
│ Admin · Sources                                       [⌘K]   │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  Sources                                                      │
│  Connect external systems that feed your PRD vault.          │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ● Notion                                       [Run now]│ │
│  │   Database: Product Backlog (3f6ac861…)                │ │
│  │   ───────────────────────────────────────────────────── │ │
│  │   Last run: 2h ago by cron · ok                         │ │
│  │   synced 4 · skipped 0 · archived 0 · errors 0          │ │
│  │   Next run: in 4h                                       │ │
│  │                                                         │ │
│  │   Recent runs                                           │ │
│  │   ● 14:30  ok     4/0/0/0   18s                         │ │
│  │   ● 10:30  ok     0/0/0/0    4s                         │ │
│  │   ● 06:30  error  12/3/0/2   See logs ↗                 │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ○ Confluence  (coming soon)                             │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

- **Data:** `GET /api/admin/sources` (NEW) — returns list with last manifest parsed from `vault/.manifests/sync/*.json`
- **Run now:** `POST /api/admin/sources/{id}/run` (NEW) — kicks off subprocess in app container, returns `{run_id}`. Frontend polls `GET /api/admin/sources/{id}/runs/{run_id}` until terminal state.
- **Recent runs:** last 10 from `vault/.manifests/sync/`, newest first
- **Backend change (small):** new `web/sources.py` router with 3 routes; subprocess runner uses `asyncio.create_subprocess_exec` with the existing `npm run sync` CLI; writes output to manifest dir.
- **Permission:** `users.manage` (admin)
- **Run-now confirm dialog:** "This will write to the vault and re-index Chroma. Continue?"
- **Disabled during running:** button replaced with spinner + "Running… 0:14" (elapsed)

### F3. Conversation history in Ask (`/ask`)

```
┌──────────┬────────────────────────────────────────────────────┐
│ Library  │  Ask                                           │
│ Search   │  ┌────────────────────────────────────────────┐  │
│ Ask      │  │  New chat                                  │  │
│  + New   │  └────────────────────────────────────────────┘  │
│  ──────  │                                                    │
│  ▸ Onboa │  Q: What's our onboarding flow for…?              │
│  ▸ Payme │                                                    │
│  ▸ Card  │  A: We currently require PMs to … [3 sources]    │
│  ▸ Refi  │                                                    │
│  ▸ + 7   │  [Ask anything…]                       [Send ⏎]   │
│ Status   │                                                    │
└──────────┴────────────────────────────────────────────────────┘
```

- **Data:** existing `GET/POST/DELETE /api/chat/conversations` (CRUD exists)
- **Rail:** title = first user message truncated to 60 chars, timestamp, hover-revealed delete icon
- **Persistence:** current `conversation_id` in URL hash (`/ask#c=abc123`) — reload keeps context
- **Empty state:** centered "Start by asking about any PRD" with example prompts
- **New chat:** clears rail selection, focuses composer
- **Delete:** confirmation dialog, optimistic removal with rollback on error

### F4. Full user management + self-serve change password

**Directory (`/admin/directory`)** — replace current page with `DataTable`:

```
┌───────────────────────────────────────────────────────────────┐
│ Admin · Users                                       [⌘K]     │
├───────────────────────────────────────────────────────────────┤
│  Users (24)                          [Search] [+ Invite]       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Name ▾    Email           Roles        Status   Actions │ │
│  ├─────────────────────────────────────────────────────────┤ │
│  │ Duy Pham  duy@…  [Admin] [PM]    Active   ⋯           │ │
│  │ Linh N.   linh@… [PM]            Pending  ⋯           │ │
│  │ Hung T.   hung@… [Admin]         Disabled ⋯           │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

- Row action menu (`⋯`): Reset password · Disable/Enable · Manage roles · Delete
- **Reset password** dialog: "A new temporary password will be shown ONCE. Copy it now." → reveals password + copy button
- **Manage roles** dialog: checkboxes from `GET /api/admin/permissions`, saves via `PUT /api/admin/users/{id}/roles`
- **Disable/Enable:** instant action with toast; row badge updates optimistically
- **Delete:** typed-confirm (type email)
- **Detail drawer (clicking row):** Vaul drawer slides from right; shows audit fields (last_login, created, last_password_change)

**Change password (self-serve)** — user menu in top bar:
- Modal: Current password · New password · Confirm
- Validation: zod schema (min 8 chars, must differ from current)
- Success: toast "Password updated" + auto sign-out (forces re-login with new password) OR keep session — pick whichever the backend already supports; if ambiguous, ask Duy
- Failure: inline error toast (current password wrong → field error)

### F5. Polish (cross-cutting)

- **⌘K palette:** global, opens on `Cmd+K`/`Ctrl+K`, lists pages + recent PRDs + quick actions (Run Notion sync, New chat, Invite user). cmdk fuzzy search.
- **Empty states:** every list page has one (Library empty, Search no-results, Ask no conversations, Directory no users, Sources no sources)
- **Motion:** framer-motion `<AnimatePresence>` on route transitions (200ms fade), list items stagger-in (50ms), card hover lift (translateY -1px + shadow-md)
- **Loading:** every async boundary shows Skeleton (no spinner-only screens)
- **Dark mode:** toggle in top bar; respects system preference on first visit; persisted to localStorage; no flash on reload (inline script in `index.html`)
- **Keyboard:** `g l` → Library, `g s` → Search, `g a` → Ask, `g s` → Status, `?` → shortcut help
- **Accessibility:** all primitives Radix-backed (focus traps, ARIA), skip-to-content link, visible focus rings, `prefers-reduced-motion` honored

## Backend Touches (minimal — keep the door narrow)

The whole point of this phase is "stop leaving features behind the door". So:

| File | Change |
|---|---|
| `mcp/prd_mcp/web/sources.py` | NEW — 3 routes (list sources, list runs, trigger run) |
| `mcp/prd_mcp/server.py` | Mount sources router |
| `mcp/prd_mcp/web/admin.py` | Possibly add `GET /admin/users/{id}` if missing (verify) |
| `mcp/prd_mcp/cli.py` | No change — sync CLI already exists |
| `mcp/deploy/Dockerfile` | No change — sync CLI already shipped via `app` image |
| `mcp/deploy/docker-compose.yml` | No change — sources router runs in existing app container |

**Subprocess safety for sync trigger:**
- App container must have `npm` + `node_modules` + `src/` (already does — it's the same image we ship today, which builds from repo root)
- Validate `run_id` is a UUID before exec
- Lock per-source mutex so concurrent "Run now" calls serialize
- Stream stdout to logs; capture exit code; write manifest on completion
- 5-minute hard timeout; kill + mark as `error` on timeout

## Out of Scope / Defer

- **Command palette actions that POST** (e.g., "Run sync" from ⌘K) — defer; first version of palette is navigation-only
- **Notifications** — bell is a placeholder; no real notification engine
- **Multi-PRD comparison view** — defer
- **PRD diff between sync runs** — defer (the data exists in manifests but UI is complex)
- **Re-enrichment trigger from PRD detail** — wire up the button, leave the actual enrich call to a thin stub that returns "started" and toasts success (real enrich is heavy; defer the wiring)

## Risks

1. **shadcn install on Tailwind v4** — v4 has new config syntax; shadcn's CLI may not match cleanly. Mitigation: pin to Tailwind v3.4 if v4 integration breaks; document the choice.
2. **Sync subprocess in app container** — adds a new class of failure (hung processes, partial writes). Mitigation: mutex + 5min timeout + manifest check before/after.
3. **react-markdown bundle size** — gfm + rehype-raw is ~80kb gz. Mitigation: lazy-load on PRD detail route only.
4. **Dark mode flash** — easy to get wrong; mitigation is the inline script in `index.html` reading localStorage before React mounts.
5. **Scope** — 4 features + redesign is large. If we slip, the cuts (in plan) are: (a) Sources → read-only status, no "Run now"; (b) Conversation history → dropdown, not rail; (c) Reset password dialog → inline form, no reveal-once copy.

## Decisions Log

- **2026-06-25** Direction: Linear/Notion-vibe clean SaaS, single indigo accent.
- **2026-06-25** Stack: shadcn/ui + Tailwind + Radix (no meta-framework swap).
- **2026-06-25** Audience: 1–3 PMs primary, internal team secondary.
- **2026-06-25** Sync UI: HTTP door in app container + manifest reads (NO scheduler UI — cron stays opaque).
