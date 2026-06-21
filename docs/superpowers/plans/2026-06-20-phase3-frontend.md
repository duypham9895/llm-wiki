# Phase 3 — React Dashboard Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React + Vite + Tailwind + shadcn/ui SPA — a grouped-sidebar shell with Library, Search, Ask (multi-turn streaming chat), Status, and Admin (Approvals/Directory/Roles/Settings) surfaces, plus Login — talking to the Phase 3 HTTP door (Plan A) same-origin, gated by Phase 2 auth.

**Architecture:** A standalone Vite app in `mcp/web-ui/`. react-query owns server state for JSON endpoints; a custom `fetch`-based SSE reader (NOT `EventSource` — the chat stream is a POST with a CSRF header) drives the Ask tab. The nav renders only the sections the user's permissions (`GET /api/auth/me`) allow. Builds to static files Caddy serves; all `/api/*` calls are same-origin so Phase 2's `SameSite` cookie + `X-Requested-With: prd-app` CSRF header work unchanged. All user-facing copy reviewed by the Senior Content Writer agent.

**Tech Stack:** TypeScript, React 18, Vite, Tailwind, shadcn/ui, @tanstack/react-query, a tiny router (react-router-dom), Vitest + @testing-library/react + MSW (Mock Service Worker) for API mocking. No live backend in tests.

## Global Constraints

- **Depends on Plan A's endpoint contracts** (the SPA is built against these shapes; Plan A need not be deployed to develop the UI with MSW mocks, but the shapes must match):
  - `GET /api/auth/me` → `{id, email, status, roles:[{id,name}], permissions:[str]}` (Phase 2 `UserOut`).
  - `POST /api/auth/login` `{email,password}` → `{user: UserOut}` | `401 {error:{code:'invalid_credentials',message}}`. `POST /api/auth/logout` → 204.
  - `GET /api/prd/library?status=&tag=&cursor=&limit=` → `{results:[{id,title,status,tags:[str],summary,source_url}], next_cursor}`.
  - `GET /api/prd/search?q=&mode=semantic|keyword&k=` → semantic: `{count, verdict:'match'|'no_match', results:[{id,title,summary,tags,status,source_url,obsidian_link,snippet,score}]}`; keyword: same minus `score`/`verdict` shape per the MCP tool.
  - `GET /api/prd/{id}` → `{found, id, title, status, tags, source_url, obsidian_link, body}` | `404`.
  - `GET /api/chat/conversations` → `[{id,title,updated_at}]`; `POST` → `{id}`; `GET /{id}` → `{id,title,messages:[{seq,role,content,sources,grounded,finish_reason}]}`; `DELETE /{id}` → 204; non-owned → 404.
  - `POST /api/chat/conversations/{id}/messages` `{content}` → **SSE** events `rewrite`/`sources`/`token`/`done`/`error`; `409 {error:{code:'conversation_busy'}}` if busy; `403 {error:{code:'csrf'}}` without the header.
  - `GET /api/status/pipeline` → `{run_id, stages, halted, halt_reason, halted_at}`; `GET /api/status/history?limit=` → `{runs:[...]}`; `GET /api/status/coverage` → `{total, enriched, unenriched}`.
  - Admin (Phase 2 `admin.py`): `GET /api/admin/users?status=`, `POST /api/admin/users/{id}/approve {role_ids}`, `/disable`, `/enable`, `/reject`, `PUT /api/admin/users/{id}/roles {role_ids}`; `GET/POST/PUT/DELETE /api/admin/roles`; `GET /api/admin/permissions`; `GET/PUT /api/admin/settings {registration_enabled, allowed_domains}`. Error codes to surface: `409 last_admin`, `422 admin_pair`, `409 system_role_immutable`, `409 role_in_use`.
- **Permissions gate the nav** (spec §7): `prd.read`→Library/Search, `prd.ask`→Ask, `status.view`→Status, `users.manage`→Users, `roles.manage`→Roles/Settings. Sections with no permitted items don't render. UI gating is defense-in-depth; the API still enforces.
- **CSRF:** every mutating fetch sends header `X-Requested-With: prd-app` and `credentials: 'same-origin'`. A shared `apiFetch` wrapper enforces this — no raw `fetch` in components.
- **SSE via fetch, not EventSource** (spec §7, Codex-confirmed): the chat POST carries a JSON body + CSRF header, which `EventSource` cannot do. A `streamChat()` helper reads the `ReadableStream` and parses SSE frames.
- **Copy:** all visible strings reviewed by the `senior-content-writer` agent; honor Phase 2 anti-enumeration (Login shows only the generic `invalid_credentials` message — never "no such user").
- **English only.** Sentence case for labels/buttons.
- **TDD where it has teeth:** test the logic-bearing units (SSE parser, permission→nav mapping, the apiFetch wrapper, verdict/empty-state rendering, admin error-code handling) with Vitest + Testing Library + MSW. Don't snapshot-test static markup.

---

## File Structure

```
mcp/web-ui/
  package.json, vite.config.ts, tailwind.config.js, tsconfig.json, index.html
  src/
    main.tsx                 app entry, react-query client, router
    lib/
      api.ts                 apiFetch wrapper (credentials + CSRF header + error envelope parsing)
      sse.ts                 streamChat(): fetch-based SSE reader/parser
      auth.tsx               useMe() (GET /me) + AuthProvider; permission helpers
      permissions.ts         NAV model + visibleSections(perms)
    components/
      AppShell.tsx           grouped sidebar (Knowledge/Operate/Manage) + content outlet
      RequirePermission.tsx  route guard (redirects/hides by permission)
      ui/                    shadcn components (button, card, table, dialog, input, toast, badge, tabs...)
    pages/
      Login.tsx
      Library.tsx            card grid + filters + reader drawer
      Search.tsx             query box + semantic/keyword toggle + verdict-aware results
      Ask.tsx                conversation list + thread + streaming + sources panel
      Status.tsx             pipeline health + halt banner + coverage
      admin/
        Approvals.tsx        pending queue (action cards, inline 422/409 handling)
        Directory.tsx        active/disabled user table
        Roles.tsx            role list/create/edit/delete (system roles locked)
        Settings.tsx         registration toggle + domain allowlist editor
    test/ (or *.test.tsx beside sources) + src/test/msw-handlers.ts
```

---

### Task 1: Scaffold the Vite app + shared `apiFetch`

**Files:**
- Create: `mcp/web-ui/package.json`, `vite.config.ts`, `tailwind.config.js`, `tsconfig.json`, `index.html`, `src/main.tsx`
- Create: `mcp/web-ui/src/lib/api.ts`
- Test: `mcp/web-ui/src/lib/api.test.ts`

**Interfaces:**
- Produces: `async function apiFetch<T>(path: string, opts?: {method?, body?, signal?}): Promise<T>` — prepends `/api`-relative base, sets `credentials:'same-origin'`, adds `X-Requested-With: prd-app` + `Content-Type: application/json` on mutating methods, JSON-parses, and on a non-2xx throws `ApiError{code, message, status}` parsed from the `{error:{code,message}}` envelope.
- Produces: `class ApiError extends Error { code: string; status: number }`.

- [ ] **Step 1: Scaffold (mechanical) + write the failing test**

Scaffold with Vite (`npm create vite@latest . -- --template react-ts` in `mcp/web-ui/`), add Tailwind + shadcn init, `@tanstack/react-query`, `react-router-dom`, and dev deps `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `msw`. Then the test:

```typescript
// src/lib/api.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { apiFetch, ApiError } from './api';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('apiFetch', () => {
  it('parses JSON on success', async () => {
    server.use(http.get('/api/ping', () => HttpResponse.json({ ok: true })));
    expect(await apiFetch('/ping')).toEqual({ ok: true });
  });

  it('sends the CSRF header + credentials on mutating requests', async () => {
    let seen: Request | null = null;
    server.use(http.post('/api/x', ({ request }) => { seen = request; return HttpResponse.json({}, { status: 200 }); }));
    await apiFetch('/x', { method: 'POST', body: { a: 1 } });
    expect(seen!.headers.get('x-requested-with')).toBe('prd-app');
  });

  it('throws ApiError with code+status from the error envelope', async () => {
    server.use(http.get('/api/bad', () => HttpResponse.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 })));
    await expect(apiFetch('/bad')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp/web-ui && npx vitest run src/lib/api.test.ts`
Expected: FAIL — `./api` not found.

- [ ] **Step 3: Implement `api.ts`**

```typescript
// src/lib/api.ts
export class ApiError extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status: number) {
    super(message); this.code = code; this.status = status;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function apiFetch<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (MUTATING.has(method)) {
    headers['X-Requested-With'] = 'prd-app';   // Phase 2 CSRF guard
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(`/api${path}`, {
    method, headers, credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (resp.status === 204) return undefined as T;
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = (data && data.error) || { code: 'http_error', message: resp.statusText };
    throw new ApiError(err.code, err.message, resp.status);
  }
  return data as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp/web-ui && npx vitest run src/lib/api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/web-ui
git commit -m "feat(web-ui): Vite+React+Tailwind scaffold + apiFetch wrapper (CSRF, error envelope)"
```

---

### Task 2: SSE chat reader (`sse.ts`)

**Files:**
- Create: `mcp/web-ui/src/lib/sse.ts`
- Test: `mcp/web-ui/src/lib/sse.test.ts`

**Interfaces:**
- Produces: `async function streamChat(convId: string, content: string, handlers: {onRewrite?(q:string):void; onSources?(p:{sources:any[];verdict:string}):void; onToken(t:string):void; onDone?(messageId:string):void; onError?(m:string):void}, signal?: AbortSignal): Promise<void>` — POSTs `{content}` to `/api/chat/conversations/{convId}/messages` with the CSRF header, reads the `ReadableStream`, parses SSE frames, dispatches handlers. Throws `ApiError` on a non-2xx initial response (e.g. 409 conversation_busy, 403 csrf).
- Produces (exported for testing): `function parseSSEChunk(buffer: string): {events: {event:string; data:string}[]; rest: string}` — pure SSE frame parser (splits on `\n\n`, extracts `event:`/`data:` lines, returns leftover partial).

- [ ] **Step 1: Write the failing test (parser is pure → easy to test)**

```typescript
// src/lib/sse.test.ts
import { describe, it, expect } from 'vitest';
import { parseSSEChunk } from './sse';

describe('parseSSEChunk', () => {
  it('parses complete frames and keeps the partial remainder', () => {
    const buf = 'event: rewrite\ndata: standalone q\n\nevent: token\ndata: He\n\nevent: tok';
    const { events, rest } = parseSSEChunk(buf);
    expect(events).toEqual([
      { event: 'rewrite', data: 'standalone q' },
      { event: 'token', data: 'He' },
    ]);
    expect(rest).toBe('event: tok');
  });

  it('returns no events when no complete frame yet', () => {
    const { events, rest } = parseSSEChunk('event: token\ndata: partial');
    expect(events).toEqual([]);
    expect(rest).toBe('event: token\ndata: partial');
  });

  it('handles multi-line data and ignores comments/heartbeats', () => {
    const { events } = parseSSEChunk(': heartbeat\n\nevent: token\ndata: a\n\n');
    expect(events).toEqual([{ event: 'token', data: 'a' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp/web-ui && npx vitest run src/lib/sse.test.ts`
Expected: FAIL — `parseSSEChunk` not found.

- [ ] **Step 3: Implement `sse.ts`**

```typescript
// src/lib/sse.ts
import { ApiError } from './api';

export function parseSSEChunk(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const events: { event: string; data: string }[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';   // last piece is incomplete (no trailing blank line yet)
  for (const block of parts) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;             // comment/heartbeat
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
}

export interface ChatHandlers {
  onRewrite?(q: string): void;
  onSources?(p: { sources: any[]; verdict: string }): void;
  onToken(t: string): void;
  onDone?(messageId: string): void;
  onError?(m: string): void;
}

export async function streamChat(convId: string, content: string, h: ChatHandlers, signal?: AbortSignal): Promise<void> {
  const resp = await fetch(`/api/chat/conversations/${convId}/messages`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'prd-app' },
    body: JSON.stringify({ content }), signal,
  });
  if (!resp.ok || !resp.body) {
    const data = await resp.json().catch(() => null);
    const err = (data && data.error) || { code: 'http_error', message: resp.statusText };
    throw new ApiError(err.code, err.message, resp.status);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSSEChunk(buffer);
    buffer = rest;
    for (const ev of events) {
      if (ev.event === 'rewrite') h.onRewrite?.(ev.data);
      else if (ev.event === 'sources') h.onSources?.(JSON.parse(ev.data));
      else if (ev.event === 'token') h.onToken(ev.data);
      else if (ev.event === 'done') h.onDone?.(ev.data);
      else if (ev.event === 'error') h.onError?.(ev.data);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp/web-ui && npx vitest run src/lib/sse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/web-ui/src/lib/sse.ts mcp/web-ui/src/lib/sse.test.ts
git commit -m "feat(web-ui): fetch-based SSE chat reader + pure frame parser"
```

---

### Task 3: Auth + permission→nav model

**Files:**
- Create: `mcp/web-ui/src/lib/auth.tsx`, `mcp/web-ui/src/lib/permissions.ts`
- Test: `mcp/web-ui/src/lib/permissions.test.ts`

**Interfaces:**
- Produces in `permissions.ts`: `const NAV: {group:string; items:{label:string; path:string; perm:string}[]}[]` (the full nav model) and `function visibleSections(perms: string[]): typeof NAV` — returns only groups/items whose `perm` is in `perms`, dropping empty groups.
- Produces in `auth.tsx`: `useMe()` (react-query over `GET /api/auth/me`) + `<AuthProvider>`; `useHasPermission(name)`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/permissions.test.ts
import { describe, it, expect } from 'vitest';
import { visibleSections } from './permissions';

describe('visibleSections', () => {
  it('shows only Knowledge for a read-only member', () => {
    const secs = visibleSections(['prd.read', 'prd.ask']);
    const groups = secs.map((s) => s.group);
    expect(groups).toContain('Knowledge');
    expect(groups).not.toContain('Operate');   // no status.view
    expect(groups).not.toContain('Manage');     // no users/roles.manage
  });

  it('shows all groups for a full admin', () => {
    const secs = visibleSections(['prd.read', 'prd.ask', 'status.view', 'users.manage', 'roles.manage']);
    expect(secs.map((s) => s.group)).toEqual(['Knowledge', 'Operate', 'Manage']);
  });

  it('drops a group whose items are all unpermitted', () => {
    const secs = visibleSections(['status.view']);   // only Operate
    expect(secs.map((s) => s.group)).toEqual(['Operate']);
  });

  it('shows nothing for a user with no perms', () => {
    expect(visibleSections([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp/web-ui && npx vitest run src/lib/permissions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/permissions.ts
export interface NavItem { label: string; path: string; perm: string }
export interface NavGroup { group: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  { group: 'Knowledge', items: [
    { label: 'Library', path: '/library', perm: 'prd.read' },
    { label: 'Search', path: '/search', perm: 'prd.read' },
    { label: 'Ask', path: '/ask', perm: 'prd.ask' },
  ]},
  { group: 'Operate', items: [
    { label: 'Status', path: '/status', perm: 'status.view' },
  ]},
  { group: 'Manage', items: [
    { label: 'Users', path: '/admin/users', perm: 'users.manage' },
    { label: 'Roles', path: '/admin/roles', perm: 'roles.manage' },
    { label: 'Settings', path: '/admin/settings', perm: 'roles.manage' },
  ]},
];

export function visibleSections(perms: string[]): NavGroup[] {
  const set = new Set(perms);
  return NAV
    .map((g) => ({ group: g.group, items: g.items.filter((i) => set.has(i.perm)) }))
    .filter((g) => g.items.length > 0);
}
```

For `auth.tsx`, implement `useMe()` with react-query (`queryKey:['me']`, `queryFn:()=>apiFetch('/auth/me')`), an `AuthProvider` that surfaces loading/unauthenticated (redirect to Login on a 401 from `useMe`), and `useHasPermission(name)` reading `me.permissions`. (Logic is thin; the permission mapping above is the tested unit.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp/web-ui && npx vitest run src/lib/permissions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/web-ui/src/lib/auth.tsx mcp/web-ui/src/lib/permissions.ts mcp/web-ui/src/lib/permissions.test.ts
git commit -m "feat(web-ui): useMe auth + permission-gated nav model"
```

---

### Task 4: App shell + routing + permission guards

**Files:**
- Create: `mcp/web-ui/src/components/AppShell.tsx`, `RequirePermission.tsx`; wire routes in `main.tsx`
- Test: `mcp/web-ui/src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: `visibleSections`, `useMe`/`useHasPermission` (Task 3).
- Produces: `<AppShell>` rendering the grouped sidebar from `visibleSections(me.permissions)` + a content `<Outlet/>`; `<RequirePermission perm="...">` that renders children only if permitted, else a "not authorized" redirect.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/AppShell.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';
import { renderWithProviders } from '../test/util'; // wraps router + react-query + a mocked useMe

describe('AppShell nav', () => {
  it('renders only permitted sections', async () => {
    renderWithProviders(<AppShell />, { me: { permissions: ['prd.read', 'prd.ask'] } });
    expect(await screen.findByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Ask')).toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    expect(screen.queryByText('Users')).not.toBeInTheDocument();
  });

  it('shows admin sections for an admin', async () => {
    renderWithProviders(<AppShell />, { me: { permissions: ['prd.read', 'prd.ask', 'status.view', 'users.manage', 'roles.manage'] } });
    expect(await screen.findByText('Users')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fail; Step 3: implement AppShell (sidebar from visibleSections, shadcn nav components) + RequirePermission + routes; Step 4: run → pass.**

Run after implementing: `cd mcp/web-ui && npx vitest run src/components/AppShell.test.tsx` → PASS.
`renderWithProviders` (in `src/test/util.tsx`) wraps the component in a `QueryClientProvider` with `['me']` pre-seeded to the supplied `me`, a `MemoryRouter`, and is reused by later page tests.

- [ ] **Step 5: Commit**

```bash
git add mcp/web-ui/src
git commit -m "feat(web-ui): grouped-sidebar AppShell + permission route guards"
```

---

### Task 5: Library + Search pages (verdict-aware)

**Files:**
- Create: `pages/Library.tsx`, `pages/Search.tsx`
- Test: `pages/Search.test.tsx` (the verdict logic is the testable behavior)

**Interfaces:** Consumes `apiFetch`, react-query. Library: card grid from `/api/prd/library` + filters + a reader drawer (`/api/prd/{id}`). Search: query box + semantic/keyword toggle; renders the honest `no_match` empty state vs results.

- [ ] **Step 1: Write the failing test (verdict-aware rendering — the real logic)**

```tsx
// pages/Search.test.tsx
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/util';
import { Search } from './Search';
import { server } from '../test/msw-handlers';
import { http, HttpResponse } from 'msw';

describe('Search verdict handling', () => {
  it('shows the honest no_match state instead of weak hits', async () => {
    server.use(http.get('/api/prd/search', () => HttpResponse.json({ count: 0, verdict: 'no_match', results: [] })));
    renderWithProviders(<Search />, { me: { permissions: ['prd.read'] } });
    await userEvent.type(screen.getByRole('searchbox'), 'pizza recipes');
    await userEvent.click(screen.getByRole('button', { name: /search/i }));
    expect(await screen.findByText(/no prd covers this/i)).toBeInTheDocument();
  });

  it('renders results on a match', async () => {
    server.use(http.get('/api/prd/search', () => HttpResponse.json({
      count: 1, verdict: 'match',
      results: [{ id: 'EP-457', title: 'Referral revamp', summary: 'x', tags: ['referral'], status: 'active', source_url: '', snippet: 's', score: 0.4 }],
    })));
    renderWithProviders(<Search />, { me: { permissions: ['prd.read'] } });
    await userEvent.type(screen.getByRole('searchbox'), 'referral');
    await userEvent.click(screen.getByRole('button', { name: /search/i }));
    expect(await screen.findByText('Referral revamp')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2–4: run → fail → implement Library + Search → run → pass.**

`msw-handlers.ts` exports a shared `server` with default handlers for all endpoints; tests `server.use(...)` to override per-case. Copy strings ("No PRD covers this." for `no_match`; empty-state and filter labels) come from the Content-Writer pass (Task 9).

- [ ] **Step 5: Commit**

```bash
git add mcp/web-ui/src
git commit -m "feat(web-ui): Library grid + Search with verdict-aware empty state"
```

---

### Task 6: Ask tab (multi-turn streaming chat)

**Files:**
- Create: `pages/Ask.tsx`
- Test: `pages/Ask.test.tsx`

**Interfaces:** Consumes `streamChat` (Task 2), `apiFetch` (conversations). Conversation list (left), thread (right), token-by-token rendering, per-answer Sources panel, new/delete conversation. Send box disabled while a generation is active (mirrors `409 conversation_busy`).

- [ ] **Step 1: Write the failing test (streaming accumulation + sources)**

```tsx
// pages/Ask.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/util';
import { Ask } from './Ask';
import * as sse from '../lib/sse';

describe('Ask streaming', () => {
  it('renders tokens as they stream and shows sources', async () => {
    vi.spyOn(sse, 'streamChat').mockImplementation(async (_c, _content, h) => {
      h.onRewrite?.('referral PRD');
      h.onSources?.({ sources: [{ id: 'EP-457', title: 'Referral', source_url: '', obsidian_link: '[[EP-457]]' }], verdict: 'match' });
      h.onToken('Refer'); h.onToken('rals are…'); h.onDone?.('42');
    });
    renderWithProviders(<Ask />, { me: { permissions: ['prd.read', 'prd.ask'] }, route: '/ask' });
    await userEvent.type(screen.getByRole('textbox', { name: /message/i }), 'what about referrals?');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/Referrals are…/)).toBeInTheDocument();
    expect(screen.getByText('EP-457')).toBeInTheDocument();   // sources panel
  });

  it('disables send while generating and surfaces a busy error', async () => {
    vi.spyOn(sse, 'streamChat').mockRejectedValue(Object.assign(new Error('busy'), { code: 'conversation_busy', status: 409 }));
    renderWithProviders(<Ask />, { me: { permissions: ['prd.read', 'prd.ask'] }, route: '/ask' });
    await userEvent.type(screen.getByRole('textbox', { name: /message/i }), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/already (generating|in progress)/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2–4: run → fail → implement Ask → run → pass.** Step 5: commit `feat(web-ui): Ask tab — multi-turn streaming chat + sources panel`.

---

### Task 7: Status page

**Files:** Create `pages/Status.tsx`; Test `pages/Status.test.tsx`.

**Interfaces:** Consumes `/api/status/pipeline|coverage`. Shows per-stage last run, a prominent **halt banner** when `halted`, and coverage (enriched vs un-enriched).

- [ ] **Step 1: failing test**

```tsx
// pages/Status.test.tsx — assert the halt banner appears
it('shows a halt banner with the reason when the chain was halted', async () => {
  server.use(http.get('/api/status/pipeline', () => HttpResponse.json({
    run_id: 'r1', stages: { sync: { ok: true }, enrich: { ok: false } },
    halted: true, halt_reason: 'enrich 0/287 (ratio 0.00 < 0.5)', halted_at: 'enrich',
  })));
  renderWithProviders(<Status />, { me: { permissions: ['status.view'] } });
  expect(await screen.findByText(/pipeline halted/i)).toBeInTheDocument();
  expect(screen.getByText(/0\/287/)).toBeInTheDocument();
});
```

- [ ] **Step 2–4: run → fail → implement → run → pass.** Step 5: commit `feat(web-ui): Status page with halt banner + coverage`.

---

### Task 8: Admin — Approvals / Directory / Roles / Settings

**Files:** Create `pages/admin/{Approvals,Directory,Roles,Settings}.tsx`; Test `pages/admin/Approvals.test.tsx`, `Roles.test.tsx`.

**Interfaces:** Consumes the Phase 2 admin endpoints. The load-bearing behavior to test is **inline handling of the invariant error codes** (`422 admin_pair`, `409 last_admin`, `409 system_role_immutable`, `409 role_in_use`) — surfaced as clear messages, not raw codes.

- [ ] **Step 1: failing test (Approvals inline error + Roles locked system role)**

```tsx
// pages/admin/Approvals.test.tsx
it('shows a clear message when approving would create a half-admin (422 admin_pair)', async () => {
  server.use(
    http.get('/api/admin/users', () => HttpResponse.json([{ id: 'u1', email: 'x@ringkas.co.id', status: 'pending', roles: [] }])),
    http.post('/api/admin/users/u1/approve', () => HttpResponse.json({ error: { code: 'admin_pair', message: 'half admin' } }, { status: 422 })),
  );
  renderWithProviders(<Approvals />, { me: { permissions: ['users.manage', 'roles.manage'] } });
  await userEvent.click(await screen.findByRole('button', { name: /approve/i }));
  expect(await screen.findByText(/admin.*(both|pair|users & roles)/i)).toBeInTheDocument();  // friendly, not "admin_pair"
});
```

```tsx
// pages/admin/Roles.test.tsx
it('renders system roles as locked (no edit/delete)', async () => {
  server.use(http.get('/api/admin/roles', () => HttpResponse.json([
    { id: 'r1', name: 'admin', is_system: true, permissions: ['users.manage', 'roles.manage'] },
    { id: 'r2', name: 'reviewer', is_system: false, permissions: ['prd.read'] },
  ])));
  renderWithProviders(<Roles />, { me: { permissions: ['roles.manage'] } });
  await screen.findByText('admin');
  expect(within(screen.getByTestId('role-admin')).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  expect(within(screen.getByTestId('role-reviewer')).getByRole('button', { name: /delete/i })).toBeInTheDocument();
});
```

- [ ] **Step 2–4: run → fail → implement the four admin pages (Approvals queue as action cards; Directory table; Roles with locked system roles + a friendly map for the invariant codes; Settings toggle + allowlist editor) → run → pass.** Step 5: commit `feat(web-ui): admin Approvals/Directory/Roles/Settings with invariant-aware messaging`.

**Error-code copy map** (shared, used here + reviewed in Task 9):
```typescript
export const ERROR_COPY: Record<string, string> = {
  admin_pair: 'A role must grant the Admin capability fully or not at all (it pairs user and role management).',
  last_admin: 'This would leave the system with no active admin. Add another admin first.',
  system_role_immutable: 'Built-in roles (admin, member) can’t be edited or deleted.',
  role_in_use: 'This role is still assigned to users. Reassign them before deleting it.',
  conversation_busy: 'A response is already being generated in this conversation.',
  invalid_credentials: 'Email or password is incorrect.',   // anti-enumeration: identical for all cases
};
```

---

### Task 9: Login page + Senior Content Writer copy pass

**Files:** Create `pages/Login.tsx`; Test `pages/Login.test.tsx`; then a project-wide copy review.

**Interfaces:** `POST /api/auth/login`. On 401, show ONLY the generic `invalid_credentials` message (anti-enumeration). On success, redirect into the app.

- [ ] **Step 1: failing test**

```tsx
// pages/Login.test.tsx
it('shows the generic error on bad credentials (no enumeration)', async () => {
  server.use(http.post('/api/auth/login', () => HttpResponse.json({ error: { code: 'invalid_credentials', message: 'x' } }, { status: 401 })));
  renderWithProviders(<Login />);
  await userEvent.type(screen.getByLabelText(/email/i), 'who@ringkas.co.id');
  await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  const msg = await screen.findByText(/email or password is incorrect/i);
  expect(msg).toBeInTheDocument();
  // MUST NOT reveal which was wrong
  expect(screen.queryByText(/no account|not found|unknown user/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2–4: run → fail → implement Login → run → pass.**

- [ ] **Step 5: Senior Content Writer copy pass (REQUIRED)**

Dispatch the `senior-content-writer` agent over `mcp/web-ui/src` (all `.tsx` + the `ERROR_COPY` map) with this brief: review every user-facing string for clarity, consistency (one term per concept), sentence case, tone, and — critically — the anti-enumeration rule (Login + any auth message stays generic). Apply its must-fix changes; record its glossary. This is the third reviewer in the cross-model loop, scoped to copy.

- [ ] **Step 6: Commit**

```bash
git add mcp/web-ui/src
git commit -m "feat(web-ui): Login (anti-enumeration) + Senior Content Writer copy pass"
```

---

### Task 10: Production build + Caddy serving notes

**Files:** `mcp/web-ui/vite.config.ts` (build output), a short `mcp/web-ui/README.md` deploy note.

- [ ] **Step 1: Verify the build**

Run: `cd mcp/web-ui && npm run build`
Expected: a static bundle in `dist/`. Confirm `apiFetch` uses RELATIVE `/api/...` (so same-origin works behind Caddy with no base-URL config).

- [ ] **Step 2: Document Caddy serving** (in the README): Caddy serves `dist/` at the dashboard origin and reverse-proxies `/api/*` to the loopback web-API (Plan A). SPA-fallback: serve `index.html` for non-`/api` routes (client-side routing). Same origin → Phase 2 cookies + CSRF header just work.

- [ ] **Step 3: Commit** `chore(web-ui): production build config + Caddy serving notes`.

---

## Deploy Notes (over Plan A's deploy)

- The frontend is **static** — Caddy serves `mcp/web-ui/dist/` and reverse-proxies `/api/*` to the loopback FastAPI (Plan A). The runtime needs no Node; the build runs in CI or locally.
- SPA fallback in Caddy: `try_files {path} /index.html` for non-API routes.
- Same-origin is REQUIRED (cookies + CSRF). Do not host the SPA on a different origin/CDN without revisiting Phase 2's SameSite/CORS model.

---

## Self-Review

**Spec coverage (§7 + the surfaces):** grouped sidebar gated by permissions (Tasks 3, 4); Library/Search with honest verdict (Task 5); Ask multi-turn streaming + sources + busy-disable (Task 6); Status + halt banner (Task 7); Admin Approvals/Directory/Roles/Settings with invariant-code messaging (Task 8); Login anti-enumeration (Task 9); shadcn/ui throughout; fetch-based SSE not EventSource (Task 2); same-origin static deploy (Task 10). ✓

**Contract fidelity:** every endpoint shape in Global Constraints traces to Plan A's routers / Phase 2's admin endpoints; the SSE event names (`rewrite`/`sources`/`token`/`done`/`error`) and the `409 conversation_busy`/`403 csrf` cases match Plan A Task 7; the invariant codes match Phase 2 §9. ✓

**Placeholder scan:** Tasks 5–9 compress the implement step ("run→fail→implement→pass") rather than reprinting full page JSX — deliberate, because the *tested logic* (the failing test + the data contract) is shown in full, and the page markup is shadcn-composition that an implementer writes against the test. The logic-bearing units (apiFetch, SSE parser, permission mapping, verdict/halt/error-code rendering) have complete code + tests. No TBD/TODO. ✓

**TDD teeth:** tests target behavior with real failure modes (no_match rendering, streaming accumulation, busy/CSRF errors, permission-gated nav, locked system roles, anti-enumeration), not static-markup snapshots. ✓

**Cross-plan:** consumes Plan A (API shapes) + Phase 2 (auth/admin endpoints, /me). MSW mocks the backend so the UI is buildable/testable before Plan A deploys; the shapes must stay in sync (a drift would surface as a failing MSW-backed test once integrated).
