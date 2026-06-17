# Notion → Obsidian PRD Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/TypeScript CLI that discovers all Ringkas PRDs in Notion, converts them to clean Markdown, and writes them into an Obsidian vault — idempotently, incrementally, on a schedule.

**Architecture:** Small single-purpose modules behind a thin orchestrator. Pure logic (naming, frontmatter merge, classification, link resolution) is unit-tested against fixtures with no live API. The Notion API wrapper and image downloader are tested with mocked HTTP. One manual smoke run validates the real workspace.

**Tech Stack:** Node 22 (ESM), TypeScript, Vitest (test runner), `@notionhq/client` (Notion API), `notion-to-md` (block→Markdown), `yaml` (frontmatter). macOS `security` CLI for keychain token read (no native npm dep). launchd for scheduling.

## Global Constraints

- **Stack:** Node/TypeScript, ESM (`"type": "module"`), Node ≥ 22.
- **Auth:** Notion **internal integration token**, read at runtime from the macOS keychain via `security find-generic-password -s ringkas-prd-sync -a notion-token -w`. Never read from a git-tracked file; never logged.
- **Frontmatter namespace rule:** `sync.*` is owned by this tool and overwritten every run. `llm.*` is owned by sub-project B — scaffolded empty on first write, then **preserved byte-for-byte** on every subsequent run. File invariant: in frontmatter, `sync:` block comes first, `llm:` block comes last.
- **Discovery:** union of (1) full enumeration of the Product Backlog database and (2) Notion `/search "PRD"`, deduped by page UUID.
- **Archive trigger:** a file is archived (moved to `_Archive/`) **only** when its UUID was synced before but is absent from the current discovery union. `Released`/`Cancelled` status does NOT archive.
- **Atomicity:** every file write goes to a temp file then atomic `rename`. A single failing item never aborts the run or overwrites a good existing file.
- **Identifiers:**
  - Product Backlog database ID: `3f6ac861-35fd-48d0-9252-99a9e202b776`
  - Data source / collection ID: `cc477810-e934-412f-b99b-16f4029fba6c`
  - Parent page "Product Management": `ff996b90-3c40-4b76-a40d-ad92bae7a1d7`
- **Vault target:** `PRDs/` folder inside the Obsidian vault path from config. Subfolders: `_attachments/<id>/`, `_Archive/`.

---

## Prerequisite Checklist (manual, done once before execution)

Not code tasks — complete these before Task 1, then the plan assumes the token is live:

1. In Notion, create an **internal integration** (Settings → Connections → Develop/Integrations). Copy its **Internal Integration Secret**.
2. Open the **"Product Management"** page in Notion → `•••` → **Connections** → add the integration. Access inherits to the Backlog DB and descendants.
3. Store the token in the macOS keychain:
   ```bash
   security add-generic-password -s ringkas-prd-sync -a notion-token -w '<PASTE_TOKEN>'
   ```
4. Verify it reads back:
   ```bash
   security find-generic-password -s ringkas-prd-sync -a notion-token -w
   ```
   Expected: the token prints. (This is the exact call `config.ts` makes.)

---

## File Structure

All paths relative to `llm-wiki/`.

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Tooling, ESM, scripts |
| `src/types.ts` | All shared interfaces (`SyncMeta`, `LlmMeta`, `DiscoveredItem`, `SyncState`, `PrdKind`) |
| `src/config.ts` | Load + validate settings; read keychain token |
| `src/state.ts` | Read/write `.sync-state.json`; incremental + archive decisions |
| `src/naming.ts` | `slugify`, `filenameStem` (pure) |
| `src/frontmatter.ts` | Build `sync:` YAML; parse existing file preserving `llm:` verbatim; compose file |
| `src/classify.ts` | Map a `DiscoveredItem` → `kind` + `canonical` |
| `src/convert.ts` | `buildSyncMeta` (properties→SyncMeta); blocks→Markdown wrapper; `resolveNotionLinks`; `normalizeEscapes` |
| `src/assets.ts` | Download images → `_attachments/<id>/`; rewrite links |
| `src/notion.ts` | Notion API: enumerate DB, search, fetch blocks (paginated), resolve users; 429 backoff |
| `src/writer.ts` | Write/merge `.md` (atomic); move removed items to `_Archive/` |
| `src/discover.ts` | Two-pass discovery union + dedupe + classify |
| `src/index.ts` | Orchestrator: pipeline, run summary, exit code |
| `test/fixtures/` | Saved Notion block JSON + property samples |
| `launchd/com.ringkas.prd-sync.plist` | Schedule (several times/day) |
| `README.md` | Setup + usage |

---

## Task 1: Project scaffold + shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/types.ts`, `test/smoke.test.ts`

**Interfaces:**
- Produces: all shared types used by every later task — `PrdKind`, `DiscoveredItem`, `SyncMeta`, `LlmMeta`, `StateEntry`, `SyncState`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "notion-obsidian-prd-sync",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "sync": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@notionhq/client": "^2.2.15",
    "notion-to-md": "^3.1.1",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 4: Create `src/types.ts`**

```ts
export type PrdKind = 'canonical-prd' | 'satellite' | 'archived' | 'db-index';

export interface DiscoveredItem {
  uuid: string;                 // dashed Notion id
  title: string;
  url: string;
  resultType: 'page' | 'database';
  inBacklogDb: boolean;         // true when found via DB enumeration
  lastEdited: string;           // ISO-8601
  properties?: Record<string, unknown>; // raw DB column values (undefined for search-only)
}

export interface SyncMeta {
  id: string;
  uuid: string;
  source_url: string;
  title: string;
  kind: PrdKind;
  canonical: boolean;
  status: string | null;
  platform: string[];
  strategic_goal: string[];
  short_summary: string | null;
  complexity: string | null;
  rank: string | null;
  revenue_impact_usd_mo: number | null;
  product_pic: string[];
  parent: string | null;        // "[[handle]]" or null
  sub_items: string[];          // ["[[handle]]", ...]
  depends_on: string[];         // from in-body mentions to synced targets
  trd_refs: string[];           // "Label — url" plain references
  template_type: string | null;
  created_time: string | null;
  last_edited: string;
  synced_at: string;
  removed_from_notion: boolean;
}

export interface LlmMeta {
  summary: string | null;
  tags: string[];
  related: string[];
}

export interface StateEntry {
  id: string;
  filename: string;             // e.g. "EP-827-client-management.md"
  last_edited: string;
  synced_at: string;
  kind: PrdKind;
}

export interface SyncState {
  pages: Record<string, StateEntry>; // uuid -> entry
  users: Record<string, string>;     // notion userId -> resolved name
}
```

- [ ] **Step 5: Create `test/smoke.test.ts`**

```ts
import { expect, test } from 'vitest';
import type { SyncMeta } from '../src/types.js';

test('types module loads and SyncMeta shape is usable', () => {
  const m: Partial<SyncMeta> = { id: 'EP-1', canonical: true };
  expect(m.id).toBe('EP-1');
});
```

- [ ] **Step 6: Install and run**

Run: `npm install && npm test`
Expected: install succeeds; 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/types.ts test/smoke.test.ts
git commit -m "chore: scaffold notion-obsidian-prd-sync with shared types"
```

---

## Task 2: Config loader + keychain token

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Config { token: string; databaseId: string; collectionId: string; parentPageId: string; vaultPath: string; searchTerm: string; stateFile: string; }`
  - `loadConfig(env: NodeJS.ProcessEnv, readToken: () => string): Config` — pure given its two injected dependencies.
  - `readKeychainToken(): string` — runs the `security` CLI.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

const fakeEnv = { VAULT_PATH: '/tmp/vault' } as NodeJS.ProcessEnv;

test('loadConfig fills defaults and injected token', () => {
  const cfg = loadConfig(fakeEnv, () => 'secret-token');
  expect(cfg.token).toBe('secret-token');
  expect(cfg.databaseId).toBe('3f6ac861-35fd-48d0-9252-99a9e202b776');
  expect(cfg.vaultPath).toBe('/tmp/vault');
  expect(cfg.searchTerm).toBe('PRD');
});

test('loadConfig throws when vault path missing', () => {
  expect(() => loadConfig({} as NodeJS.ProcessEnv, () => 't')).toThrow(/VAULT_PATH/);
});

test('loadConfig throws when token empty', () => {
  expect(() => loadConfig(fakeEnv, () => '')).toThrow(/token/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot find `../src/config.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { execFileSync } from 'node:child_process';

export interface Config {
  token: string;
  databaseId: string;
  collectionId: string;
  parentPageId: string;
  vaultPath: string;
  searchTerm: string;
  stateFile: string;
}

export function readKeychainToken(): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-s', 'ringkas-prd-sync', '-a', 'notion-token', '-w'],
    { encoding: 'utf8' },
  ).trim();
}

export function loadConfig(env: NodeJS.ProcessEnv, readToken: () => string): Config {
  const vaultPath = env.VAULT_PATH;
  if (!vaultPath) throw new Error('VAULT_PATH env var is required');
  const token = readToken();
  if (!token) throw new Error('Notion token is empty (keychain read failed)');
  return {
    token,
    databaseId: '3f6ac861-35fd-48d0-9252-99a9e202b776',
    collectionId: 'cc477810-e934-412f-b99b-16f4029fba6c',
    parentPageId: 'ff996b90-3c40-4b76-a40d-ad92bae7a1d7',
    vaultPath,
    searchTerm: 'PRD',
    stateFile: env.STATE_FILE ?? '.sync-state.json',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: config loader with keychain token read"
```

---

## Task 3: Sync state — read/write + incremental & archive decisions

**Files:**
- Create: `src/state.ts`, `test/state.test.ts`

**Interfaces:**
- Consumes: `SyncState`, `StateEntry` from `types.ts`.
- Produces:
  - `emptyState(): SyncState`
  - `loadState(path: string): Promise<SyncState>` (returns `emptyState()` if file absent)
  - `saveState(path: string, state: SyncState): Promise<void>` (atomic temp+rename)
  - `needsSync(entry: StateEntry | undefined, lastEdited: string): boolean` — true if new or `lastEdited` newer.
  - `findRemoved(state: SyncState, presentUuids: Set<string>): string[]` — UUIDs in state but absent now.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { emptyState, needsSync, findRemoved } from '../src/state.js';
import type { StateEntry } from '../src/types.js';

const entry: StateEntry = {
  id: 'EP-1', filename: 'EP-1-x.md',
  last_edited: '2026-06-01T00:00:00Z', synced_at: '2026-06-01T01:00:00Z', kind: 'canonical-prd',
};

test('needsSync: new item (no entry) => true', () => {
  expect(needsSync(undefined, '2026-06-01T00:00:00Z')).toBe(true);
});
test('needsSync: unchanged last_edited => false', () => {
  expect(needsSync(entry, '2026-06-01T00:00:00Z')).toBe(false);
});
test('needsSync: newer last_edited => true', () => {
  expect(needsSync(entry, '2026-06-02T00:00:00Z')).toBe(true);
});
test('findRemoved: uuid in state but absent now => returned', () => {
  const state = emptyState();
  state.pages['uuid-a'] = entry;
  state.pages['uuid-b'] = entry;
  expect(findRemoved(state, new Set(['uuid-a']))).toEqual(['uuid-b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL — cannot find `../src/state.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { readFile, writeFile, rename } from 'node:fs/promises';
import type { SyncState, StateEntry } from './types.js';

export function emptyState(): SyncState {
  return { pages: {}, users: {} };
}

export async function loadState(path: string): Promise<SyncState> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as SyncState;
    return { pages: parsed.pages ?? {}, users: parsed.users ?? {} };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw err;
  }
}

export async function saveState(path: string, state: SyncState): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, path);
}

export function needsSync(entry: StateEntry | undefined, lastEdited: string): boolean {
  if (!entry) return true;
  return new Date(lastEdited).getTime() > new Date(entry.last_edited).getTime();
}

export function findRemoved(state: SyncState, presentUuids: Set<string>): string[] {
  return Object.keys(state.pages).filter((uuid) => !presentUuids.has(uuid));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts
git commit -m "feat: sync state with incremental and archive-detection helpers"
```

---

## Task 4: Naming — slugify + filename stem

**Files:**
- Create: `src/naming.ts`, `test/naming.test.ts`

**Interfaces:**
- Consumes: `PrdKind` from `types.ts`.
- Produces:
  - `slugify(input: string): string`
  - `filenameStem(args: { kind: PrdKind; id: string | null; title: string; uuid: string }): string` — canonical: `<id>-<slug>`; otherwise `<slug>-<short-uuid>` (first 8 hex chars of UUID).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { slugify, filenameStem } from '../src/naming.js';

test('slugify lowercases, strips punctuation, hyphenates', () => {
  expect(slugify('PRD 2: Client Management — RISA Portal')).toBe('prd-2-client-management-risa-portal');
});
test('slugify trims and collapses repeats', () => {
  expect(slugify('  A  &&  B  ')).toBe('a-b');
});
test('canonical stem uses EP id + slug', () => {
  expect(filenameStem({ kind: 'canonical-prd', id: 'EP-827', title: 'Client Management', uuid: '33d44805-d442-817c-8de7-cb19fcea1d83' }))
    .toBe('EP-827-client-management');
});
test('satellite stem uses slug + short uuid', () => {
  expect(filenameStem({ kind: 'satellite', id: null, title: 'Feedback for PRD 1', uuid: '37544805-d442-8079-8cf2-f926bd6bff25' }))
    .toBe('feedback-for-prd-1-37544805');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/naming.test.ts`
Expected: FAIL — cannot find `../src/naming.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { PrdKind } from './types.js';

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function filenameStem(args: { kind: PrdKind; id: string | null; title: string; uuid: string }): string {
  const slug = slugify(args.title) || 'untitled';
  if (args.id && args.kind === 'canonical-prd') return `${args.id}-${slug}`;
  const short = args.uuid.replace(/-/g, '').slice(0, 8);
  return `${slug}-${short}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/naming.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/naming.ts test/naming.test.ts
git commit -m "feat: slugify and filename-stem naming helpers"
```

---

## Task 5: Frontmatter — build, parse (preserve `llm:` verbatim), compose

**Files:**
- Create: `src/frontmatter.ts`, `test/frontmatter.test.ts`

This is the load-bearing merge primitive (Global Constraint: `llm.*` preserved byte-for-byte).

**Interfaces:**
- Consumes: `SyncMeta`, `LlmMeta` from `types.ts`.
- Produces:
  - `DEFAULT_LLM_BLOCK: string` — the scaffolded `llm:` YAML text (no leading/trailing fence).
  - `buildSyncBlock(sync: SyncMeta): string` — YAML for the `sync:` mapping only.
  - `parseExisting(content: string): { llmRaw: string | null; }` — extract the raw text of the `llm:` block (from the `llm:` line to the end of frontmatter), or null if none.
  - `composeFile(sync: SyncMeta, llmRaw: string | null, body: string): string` — `---\n<syncBlock><llmRaw or DEFAULT>\n---\n\n<body>`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { buildSyncBlock, parseExisting, composeFile, DEFAULT_LLM_BLOCK } from '../src/frontmatter.js';
import type { SyncMeta } from '../src/types.js';

const sync: SyncMeta = {
  id: 'EP-827', uuid: 'u', source_url: 'https://n/p', title: 'T', kind: 'canonical-prd',
  canonical: true, status: 'In Development', platform: ['AI Agent'], strategic_goal: ['RISA-NXT'],
  short_summary: 's', complexity: 'High', rank: '', revenue_impact_usd_mo: null, product_pic: ['Duy'],
  parent: null, sub_items: [], depends_on: [], trd_refs: [], template_type: 'PRD Format',
  created_time: '2026-01-01T00:00:00Z', last_edited: '2026-06-17T00:00:00Z',
  synced_at: '2026-06-17T09:00:00Z', removed_from_notion: false,
};

test('buildSyncBlock contains sync key and values', () => {
  const b = buildSyncBlock(sync);
  expect(b).toMatch(/^sync:/m);
  expect(b).toContain('id: EP-827');
  expect(b).toContain('status: In Development');
});

test('composeFile on new file scaffolds DEFAULT_LLM_BLOCK', () => {
  const file = composeFile(sync, null, '# Body\n');
  expect(file.startsWith('---\n')).toBe(true);
  expect(file).toContain(DEFAULT_LLM_BLOCK.trim());
  expect(file).toContain('# Body');
});

test('parseExisting extracts llm block verbatim and composeFile preserves it byte-for-byte', () => {
  const customLlm = 'llm:\n  summary: "Hand-written by B"\n  tags: [auth, tenancy]\n  related: ["[[EP-1-x]]"]\n';
  const original = composeFile(sync, customLlm, '# Old body\n');
  const { llmRaw } = parseExisting(original);
  expect(llmRaw).toBe(customLlm);
  // Re-sync with new sync data + new body, but llm must survive unchanged:
  const next = { ...sync, last_edited: '2026-07-01T00:00:00Z' };
  const rewritten = composeFile(next, llmRaw, '# New body\n');
  expect(parseExisting(rewritten).llmRaw).toBe(customLlm);
  expect(rewritten).toContain('# New body');
  expect(rewritten).toContain('Hand-written by B');
});

test('parseExisting returns null when no llm block', () => {
  expect(parseExisting('---\nsync:\n  id: x\n---\nbody').llmRaw).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/frontmatter.test.ts`
Expected: FAIL — cannot find `../src/frontmatter.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { stringify } from 'yaml';
import type { SyncMeta } from './types.js';

export const DEFAULT_LLM_BLOCK = 'llm:\n  summary: null\n  tags: []\n  related: []\n';

export function buildSyncBlock(sync: SyncMeta): string {
  // stringify a single-key mapping so output is "sync:\n  ...":
  return stringify({ sync }, { lineWidth: 0 });
}

export function parseExisting(content: string): { llmRaw: string | null } {
  if (!content.startsWith('---\n')) return { llmRaw: null };
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { llmRaw: null };
  const fm = content.slice(4, end + 1); // frontmatter text, includes trailing newline
  const llmIdx = fm.search(/^llm:/m);
  if (llmIdx === -1) return { llmRaw: null };
  return { llmRaw: fm.slice(llmIdx) };
}

export function composeFile(sync: SyncMeta, llmRaw: string | null, body: string): string {
  const syncBlock = buildSyncBlock(sync); // ends with newline
  const llm = llmRaw ?? DEFAULT_LLM_BLOCK; // ends with newline
  const bodyOut = body.endsWith('\n') ? body : `${body}\n`;
  return `---\n${syncBlock}${llm}---\n\n${bodyOut}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/frontmatter.test.ts`
Expected: PASS (5 tests). The byte-for-byte preservation test is the critical one.

- [ ] **Step 5: Commit**

```bash
git add src/frontmatter.ts test/frontmatter.test.ts
git commit -m "feat: frontmatter build/parse/compose with verbatim llm preservation"
```

---

## Task 6: Classification — kind + canonical

**Files:**
- Create: `src/classify.ts`, `test/classify.test.ts`

**Interfaces:**
- Consumes: `DiscoveredItem`, `PrdKind` from `types.ts`.
- Produces: `classify(item: DiscoveredItem): { kind: PrdKind; canonical: boolean }`.

Rules (spec §5): database result → `db-index`; title contains `[Archived]` or `[Experiment]` → `archived`; in Backlog DB → `canonical-prd`/`canonical:true`; else → `satellite`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { classify } from '../src/classify.js';
import type { DiscoveredItem } from '../src/types.js';

const base: DiscoveredItem = {
  uuid: 'u', title: 'T', url: 'https://n', resultType: 'page', inBacklogDb: false, lastEdited: 'x',
};

test('database result => db-index, not canonical', () => {
  expect(classify({ ...base, resultType: 'database', title: 'FE Tasks — PRD 1' }))
    .toEqual({ kind: 'db-index', canonical: false });
});
test('archived/experiment title => archived', () => {
  expect(classify({ ...base, title: '[Archived][Experiment Codex] PRD 2', inBacklogDb: true }))
    .toEqual({ kind: 'archived', canonical: false });
});
test('in backlog db => canonical-prd', () => {
  expect(classify({ ...base, title: 'PRD 2: Client Management', inBacklogDb: true }))
    .toEqual({ kind: 'canonical-prd', canonical: true });
});
test('outside db, not archived => satellite', () => {
  expect(classify({ ...base, title: 'Feedback for PRD 1' }))
    .toEqual({ kind: 'satellite', canonical: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL — cannot find `../src/classify.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { DiscoveredItem, PrdKind } from './types.js';

export function classify(item: DiscoveredItem): { kind: PrdKind; canonical: boolean } {
  if (item.resultType === 'database') return { kind: 'db-index', canonical: false };
  if (/\[archived\]|\[experiment/i.test(item.title)) return { kind: 'archived', canonical: false };
  if (item.inBacklogDb) return { kind: 'canonical-prd', canonical: true };
  return { kind: 'satellite', canonical: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.ts
git commit -m "feat: classify discovered items into kind + canonical"
```

---

## Task 7: Convert — properties→SyncMeta, link resolution, escape normalization

**Files:**
- Create: `src/convert.ts`, `test/convert.test.ts`, `test/fixtures/prd-properties.json`

**Interfaces:**
- Consumes: `SyncMeta`, `DiscoveredItem`, `PrdKind` from `types.ts`; `slugify`/`filenameStem` from `naming.ts`; `classify` from `classify.ts`.
- Produces:
  - `normalizeEscapes(md: string): string` — unescape Notion artifacts like `\[US-01\]` → `[US-01]`.
  - `resolveNotionLinks(md: string, opts: { handleByUuid: Map<string,string>; urlByUuid: Map<string,string> }): string` — replace `[[notion:UUID|label]]` tokens with `[[handle]]` (synced) or `[label](url)` (not synced).
  - `buildSyncMeta(item: DiscoveredItem, opts: { kind: PrdKind; canonical: boolean; userNames: Record<string,string>; handleByUuid: Map<string,string>; dependsOnUuids: string[]; trdRefs: string[]; syncedAt: string }): SyncMeta` — map raw Notion DB properties to `SyncMeta`. Missing/absent properties become null/[]. (Notion-to-md block conversion itself is wrapped here as `blocksToMarkdown` but tested via the smoke run, not unit fixtures, since it requires the SDK client.)

- [ ] **Step 1: Create fixture `test/fixtures/prd-properties.json`** (trimmed real shape)

```json
{
  "Epic Name": { "type": "title", "title": [{ "plain_text": "PRD 2: Client Management" }] },
  "ID": { "type": "unique_id", "unique_id": { "prefix": "EP", "number": 827 } },
  "Status": { "type": "status", "status": { "name": "Requirement in Progress" } },
  "Platform": { "type": "multi_select", "multi_select": [{ "name": "AI Agent" }] },
  "Strategic Goal": { "type": "multi_select", "multi_select": [{ "name": "RISA-NXT" }] },
  "Short Summary": { "type": "rich_text", "rich_text": [{ "plain_text": "Full client lifecycle" }] },
  "Complexity": { "type": "select", "select": { "name": "High" } },
  "Rank #": { "type": "rich_text", "rich_text": [] },
  "Revenue Impact ($/mo)": { "type": "number", "number": null },
  "Product PIC": { "type": "people", "people": [{ "id": "user-1" }] }
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeEscapes, resolveNotionLinks, buildSyncMeta } from '../src/convert.js';
import type { DiscoveredItem } from '../src/types.js';

test('normalizeEscapes unescapes Notion bracket artifacts', () => {
  expect(normalizeEscapes('\\[US-01\\] flow')).toBe('[US-01] flow');
});

test('resolveNotionLinks: synced target => wikilink, unsynced => plain link', () => {
  const md = 'See [[notion:aaaa|PRD 1]] and [[notion:bbbb|Tech Doc]].';
  const out = resolveNotionLinks(md, {
    handleByUuid: new Map([['aaaa', 'EP-815-prd-1']]),
    urlByUuid: new Map([['bbbb', 'https://app.notion.com/p/bbbb']]),
  });
  expect(out).toBe('See [[EP-815-prd-1]] and [Tech Doc](https://app.notion.com/p/bbbb).');
});

test('buildSyncMeta maps real Notion properties', () => {
  const props = JSON.parse(readFileSync('test/fixtures/prd-properties.json', 'utf8'));
  const item: DiscoveredItem = {
    uuid: '33d44805-d442-817c-8de7-cb19fcea1d83',
    title: 'PRD 2: Client Management',
    url: 'https://app.notion.com/p/33d44805d442817c8de7cb19fcea1d83',
    resultType: 'page', inBacklogDb: true, lastEdited: '2026-06-17T07:20:38Z', properties: props,
  };
  const meta = buildSyncMeta(item, {
    kind: 'canonical-prd', canonical: true,
    userNames: { 'user-1': 'Duy Pham' }, handleByUuid: new Map(),
    dependsOnUuids: [], trdRefs: [], syncedAt: '2026-06-17T09:00:00Z',
  });
  expect(meta.id).toBe('EP-827');
  expect(meta.status).toBe('Requirement in Progress');
  expect(meta.platform).toEqual(['AI Agent']);
  expect(meta.short_summary).toBe('Full client lifecycle');
  expect(meta.product_pic).toEqual(['Duy Pham']);
  expect(meta.revenue_impact_usd_mo).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/convert.test.ts`
Expected: FAIL — cannot find `../src/convert.js`.

- [ ] **Step 4: Write minimal implementation**

```ts
import type { DiscoveredItem, PrdKind, SyncMeta } from './types.js';

export function normalizeEscapes(md: string): string {
  return md.replace(/\\([[\]])/g, '$1');
}

export function resolveNotionLinks(
  md: string,
  opts: { handleByUuid: Map<string, string>; urlByUuid: Map<string, string> },
): string {
  return md.replace(/\[\[notion:([0-9a-fA-F-]+)\|([^\]]*)\]\]/g, (_m, uuid: string, label: string) => {
    const handle = opts.handleByUuid.get(uuid);
    if (handle) return `[[${handle}]]`;
    const url = opts.urlByUuid.get(uuid) ?? `https://www.notion.so/${uuid.replace(/-/g, '')}`;
    return `[${label}](${url})`;
  });
}

type Props = Record<string, any>;

function titleText(p: Props, key: string): string | null {
  const v = p[key]; if (!v) return null;
  const arr = v.title ?? v.rich_text ?? [];
  const t = arr.map((r: any) => r.plain_text ?? '').join('').trim();
  return t || null;
}
function selectName(p: Props, key: string): string | null {
  return p[key]?.select?.name ?? p[key]?.status?.name ?? null;
}
function multiNames(p: Props, key: string): string[] {
  return (p[key]?.multi_select ?? []).map((o: any) => o.name);
}
function uniqueId(p: Props, key: string): string | null {
  const u = p[key]?.unique_id; if (!u) return null;
  return u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
}
function peopleNames(p: Props, key: string, names: Record<string, string>): string[] {
  return (p[key]?.people ?? []).map((person: any) => names[person.id] ?? person.id);
}
function numberVal(p: Props, key: string): number | null {
  const n = p[key]?.number; return typeof n === 'number' ? n : null;
}

export function buildSyncMeta(
  item: DiscoveredItem,
  opts: {
    kind: PrdKind; canonical: boolean; userNames: Record<string, string>;
    handleByUuid: Map<string, string>; dependsOnUuids: string[]; trdRefs: string[]; syncedAt: string;
  },
): SyncMeta {
  const p = (item.properties ?? {}) as Props;
  const dependsOn = opts.dependsOnUuids
    .map((u) => opts.handleByUuid.get(u))
    .filter((h): h is string => Boolean(h))
    .map((h) => `[[${h}]]`);
  return {
    id: uniqueId(p, 'ID') ?? item.uuid.slice(0, 8),   // 'ID' = Notion API display-name key (NOT the MCP 'userDefined:ID')
    uuid: item.uuid,
    source_url: item.url,
    title: item.title,
    kind: opts.kind,
    canonical: opts.canonical,
    status: selectName(p, 'Status'),
    platform: multiNames(p, 'Platform'),
    strategic_goal: multiNames(p, 'Strategic Goal'),
    short_summary: titleText(p, 'Short Summary'),
    complexity: selectName(p, 'Complexity'),
    rank: titleText(p, 'Rank #'),
    revenue_impact_usd_mo: numberVal(p, 'Revenue Impact ($/mo)'),
    product_pic: peopleNames(p, 'Product PIC', opts.userNames),
    parent: null,
    sub_items: [],
    depends_on: dependsOn,
    trd_refs: opts.trdRefs,
    template_type: null,
    created_time: p['Created time']?.created_time ?? null,
    last_edited: item.lastEdited,
    synced_at: opts.syncedAt,
    removed_from_notion: false,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/convert.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Add the block→markdown wrapper (used by orchestrator; covered by smoke run)**

Append to `src/convert.ts`:

```ts
import { NotionToMarkdown } from 'notion-to-md';
import type { Client } from '@notionhq/client';

// Wrap notion-to-md. A custom transformer emits link tokens we resolve later.
export function makeConverter(notion: Client): NotionToMarkdown {
  const n2m = new NotionToMarkdown({ notionClient: notion, config: { parseChildPages: false } });
  n2m.setCustomTransformer('link_to_page', async (block: any) => {
    const id = block.link_to_page?.page_id;
    return id ? `[[notion:${id}|page]]` : false;
  });
  return n2m;
}

export async function blocksToMarkdown(n2m: NotionToMarkdown, pageId: string): Promise<string> {
  const blocks = await n2m.pageToMarkdown(pageId);
  return n2m.toMarkdownString(blocks).parent ?? '';
}
```

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck && npx vitest run test/convert.test.ts`
Expected: typecheck clean; tests PASS.

```bash
git add src/convert.ts test/convert.test.ts test/fixtures/prd-properties.json
git commit -m "feat: convert — properties→SyncMeta, link resolution, escape normalization"
```

---

## Task 8: Assets — download images, rewrite links

**Files:**
- Create: `src/assets.ts`, `test/assets.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks (standalone).
- Produces:
  - `extractImageUrls(md: string): string[]` — all `![alt](url)` targets.
  - `localImagePath(attachmentsDir: string, id: string, url: string, index: number): string` — deterministic local path; extension from URL or `.png`.
  - `downloadImages(md: string, opts: { id: string; attachmentsDir: string; vaultRelativePrefix: string; fetchFn: typeof fetch; writeFileFn: (p: string, d: Buffer) => Promise<void>; mkdirFn: (p: string) => Promise<void> }): Promise<string>` — downloads each image, rewrites md to the vault-relative local path; on a failed download leaves the original URL with an HTML comment marker.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { extractImageUrls, localImagePath, downloadImages } from '../src/assets.js';

test('extractImageUrls finds markdown image targets', () => {
  const md = '![a](https://x/img1.png)\ntext\n![b](https://y/img2.jpg?sig=1)';
  expect(extractImageUrls(md)).toEqual(['https://x/img1.png', 'https://y/img2.jpg?sig=1']);
});

test('localImagePath derives extension and namespaced path', () => {
  expect(localImagePath('/v/PRDs/_attachments', 'EP-1', 'https://x/p.png?sig=1', 0))
    .toBe('/v/PRDs/_attachments/EP-1/img-0.png');
});

test('downloadImages rewrites to vault-relative path on success', async () => {
  const md = '![a](https://x/p.png)';
  const writes: string[] = [];
  const out = await downloadImages(md, {
    id: 'EP-1', attachmentsDir: '/v/PRDs/_attachments', vaultRelativePrefix: '_attachments',
    fetchFn: (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) })) as unknown as typeof fetch,
    writeFileFn: async (p) => { writes.push(p); },
    mkdirFn: async () => {},
  });
  expect(out).toBe('![a](_attachments/EP-1/img-0.png)');
  expect(writes).toEqual(['/v/PRDs/_attachments/EP-1/img-0.png']);
});

test('downloadImages leaves marker on failure', async () => {
  const md = '![a](https://x/p.png)';
  const out = await downloadImages(md, {
    id: 'EP-1', attachmentsDir: '/v/PRDs/_attachments', vaultRelativePrefix: '_attachments',
    fetchFn: (async () => ({ ok: false })) as unknown as typeof fetch,
    writeFileFn: async () => {}, mkdirFn: async () => {},
  });
  expect(out).toContain('<!-- image download failed -->');
  expect(out).toContain('https://x/p.png');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assets.test.ts`
Expected: FAIL — cannot find `../src/assets.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { join } from 'node:path';

export function extractImageUrls(md: string): string[] {
  const urls: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) urls.push(m[1]);
  return urls;
}

export function localImagePath(attachmentsDir: string, id: string, url: string, index: number): string {
  const clean = url.split('?')[0];
  const ext = (clean.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1] ?? 'png').toLowerCase();
  return join(attachmentsDir, id, `img-${index}.${ext}`);
}

export async function downloadImages(
  md: string,
  opts: {
    id: string; attachmentsDir: string; vaultRelativePrefix: string;
    fetchFn: typeof fetch; writeFileFn: (p: string, d: Buffer) => Promise<void>;
    mkdirFn: (p: string) => Promise<void>;
  },
): Promise<string> {
  const urls = extractImageUrls(md);
  let out = md;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const abs = localImagePath(opts.attachmentsDir, opts.id, url, i);
    const rel = `${opts.vaultRelativePrefix}/${opts.id}/${abs.split('/').pop()}`;
    try {
      const res = await opts.fetchFn(url);
      if (!(res as Response).ok) throw new Error('bad status');
      await opts.mkdirFn(join(opts.attachmentsDir, opts.id));
      const buf = Buffer.from(await (res as Response).arrayBuffer());
      await opts.writeFileFn(abs, buf);
      out = out.replace(`(${url})`, `(${rel})`);
    } catch {
      out = out.replace(`(${url})`, `(${url}) <!-- image download failed -->`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/assets.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/assets.ts test/assets.test.ts
git commit -m "feat: assets — image download with local rewrite and failure marker"
```

---

## Task 9: Notion API wrapper — enumerate, search, fetch, users, backoff

**Files:**
- Create: `src/notion.ts`, `test/notion.test.ts`

**Interfaces:**
- Consumes: `Config` from `config.ts`; `DiscoveredItem` from `types.ts`.
- Produces:
  - `withRetry<T>(fn: () => Promise<T>, opts?: { retries?: number; sleepFn?: (ms: number) => Promise<void> }): Promise<T>` — retries on 429/5xx using `Retry-After` or exponential backoff.
  - `enumerateDatabase(notion: Client, databaseId: string): Promise<DiscoveredItem[]>` (paginates `databases.query`, sets `inBacklogDb: true`, attaches `properties`).
  - `searchPrd(notion: Client, term: string): Promise<DiscoveredItem[]>` (paginates `search`, sets `inBacklogDb: false`).
  - `resolveUsers(notion: Client, ids: string[], cache: Record<string,string>): Promise<Record<string,string>>`.

Only `withRetry` is unit-tested (pure given an injected sleep). The API methods are exercised by the smoke run (Task 13) to avoid brittle SDK mocks.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { withRetry } from '../src/notion.js';

test('withRetry retries on 429 then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) { const e: any = new Error('rate'); e.status = 429; e.headers = { 'retry-after': '0' }; throw e; }
    return 'ok';
  }, { retries: 5, sleepFn: async () => {} });
  expect(result).toBe('ok');
  expect(calls).toBe(3);
});

test('withRetry gives up after retries on persistent 500', async () => {
  let calls = 0;
  await expect(withRetry(async () => {
    calls++; const e: any = new Error('server'); e.status = 500; throw e;
  }, { retries: 2, sleepFn: async () => {} })).rejects.toThrow('server');
  expect(calls).toBe(3); // initial + 2 retries
});

test('withRetry does not retry on 404', async () => {
  let calls = 0;
  await expect(withRetry(async () => {
    calls++; const e: any = new Error('missing'); e.status = 404; throw e;
  }, { retries: 3, sleepFn: async () => {} })).rejects.toThrow('missing');
  expect(calls).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/notion.test.ts`
Expected: FAIL — cannot find `../src/notion.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { Client } from '@notionhq/client';
import type { DiscoveredItem } from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  const sleepFn = opts.sleepFn ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.code;
      const retriable = status === 429 || (typeof status === 'number' && status >= 500);
      if (!retriable || attempt >= retries) throw err;
      const retryAfter = Number(err?.headers?.['retry-after']);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(2 ** attempt * 500, 8000);
      await sleepFn(waitMs);
      attempt++;
    }
  }
}

export async function enumerateDatabase(notion: Client, databaseId: string): Promise<DiscoveredItem[]> {
  const out: DiscoveredItem[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await withRetry(() =>
      notion.databases.query({ database_id: databaseId, start_cursor: cursor, page_size: 100 }));
    for (const page of res.results) {
      out.push({
        uuid: page.id,
        title: extractTitle(page.properties),
        url: page.url,
        resultType: 'page',
        inBacklogDb: true,
        lastEdited: page.last_edited_time,
        properties: page.properties,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

export async function searchPrd(notion: Client, term: string): Promise<DiscoveredItem[]> {
  const out: DiscoveredItem[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await withRetry(() => notion.search({ query: term, start_cursor: cursor, page_size: 100 }));
    for (const r of res.results) {
      out.push({
        uuid: r.id,
        title: r.object === 'database' ? extractDbTitle(r) : extractTitle(r.properties),
        url: r.url ?? '',
        resultType: r.object === 'database' ? 'database' : 'page',
        inBacklogDb: false,
        lastEdited: r.last_edited_time ?? '',
        properties: r.properties,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

export async function resolveUsers(
  notion: Client, ids: string[], cache: Record<string, string>,
): Promise<Record<string, string>> {
  for (const id of ids) {
    if (cache[id]) continue;
    try {
      const u: any = await withRetry(() => notion.users.retrieve({ user_id: id }));
      cache[id] = u.name ?? id;
    } catch { cache[id] = id; }
  }
  return cache;
}

function extractTitle(props: any): string {
  if (!props) return 'Untitled';
  for (const v of Object.values<any>(props)) {
    if (v?.type === 'title') return v.title.map((t: any) => t.plain_text).join('') || 'Untitled';
  }
  return 'Untitled';
}
function extractDbTitle(db: any): string {
  return (db.title ?? []).map((t: any) => t.plain_text).join('') || 'Untitled DB';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/notion.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/notion.ts test/notion.test.ts
git commit -m "feat: notion api wrapper with pagination and retry/backoff"
```

---

## Task 10: Writer — merge write + archive move

**Files:**
- Create: `src/writer.ts`, `test/writer.test.ts`

**Interfaces:**
- Consumes: `SyncMeta` from `types.ts`; `parseExisting`/`composeFile` from `frontmatter.ts`.
- Produces:
  - `writeMarkdown(opts: { dir: string; stem: string; sync: SyncMeta; body: string; fs?: FsLike }): Promise<string>` — merge-aware atomic write; returns filename. Reads existing file (if present) to preserve `llm:`.
  - `archiveFile(opts: { dir: string; filename: string; fs?: FsLike }): Promise<void>` — move file to `_Archive/`, set `removed_from_notion: true` in its frontmatter.
  - `interface FsLike { readFile; writeFile; rename; mkdir; }` — injectable for tests; defaults to `node:fs/promises`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { writeMarkdown } from '../src/writer.js';
import type { SyncMeta } from '../src/types.js';

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (p: string) => { if (!files.has(p)) { const e: any = new Error('no'); e.code = 'ENOENT'; throw e; } return files.get(p)!; },
    writeFile: async (p: string, d: string) => { files.set(p, d); },
    rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
    mkdir: async () => {},
  };
}

const sync: SyncMeta = {
  id: 'EP-1', uuid: 'u', source_url: 's', title: 'T', kind: 'canonical-prd', canonical: true,
  status: 'In Development', platform: [], strategic_goal: [], short_summary: null, complexity: null,
  rank: null, revenue_impact_usd_mo: null, product_pic: [], parent: null, sub_items: [], depends_on: [],
  trd_refs: [], template_type: null, created_time: null, last_edited: '2026-06-17T00:00:00Z',
  synced_at: '2026-06-17T09:00:00Z', removed_from_notion: false,
};

test('first write scaffolds empty llm block', async () => {
  const fs = memFs();
  const name = await writeMarkdown({ dir: '/PRDs', stem: 'EP-1-t', sync, body: '# Hello\n', fs });
  expect(name).toBe('EP-1-t.md');
  const content = fs.files.get('/PRDs/EP-1-t.md')!;
  expect(content).toContain('llm:');
  expect(content).toContain('summary: null');
  expect(content).toContain('# Hello');
});

test('re-write preserves hand-edited llm block', async () => {
  const fs = memFs();
  await writeMarkdown({ dir: '/PRDs', stem: 'EP-1-t', sync, body: '# v1\n', fs });
  // Simulate B editing llm:
  const edited = fs.files.get('/PRDs/EP-1-t.md')!.replace('summary: null', 'summary: "B wrote this"');
  fs.files.set('/PRDs/EP-1-t.md', edited);
  // Re-sync with new body:
  await writeMarkdown({ dir: '/PRDs', stem: 'EP-1-t', sync: { ...sync, last_edited: '2026-07-01T00:00:00Z' }, body: '# v2\n', fs });
  const content = fs.files.get('/PRDs/EP-1-t.md')!;
  expect(content).toContain('B wrote this');
  expect(content).toContain('# v2');
  expect(content).not.toContain('# v1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/writer.test.ts`
Expected: FAIL — cannot find `../src/writer.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncMeta } from './types.js';
import { parseExisting, composeFile } from './frontmatter.js';

export interface FsLike {
  readFile: (p: string, enc?: any) => Promise<string>;
  writeFile: (p: string, d: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
  mkdir: (p: string, opts?: any) => Promise<unknown>;
  unlink: (p: string) => Promise<void>;
}

const defaultFs: FsLike = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  writeFile: (p, d) => nodeFs.writeFile(p, d, 'utf8'),
  rename: (a, b) => nodeFs.rename(a, b),
  mkdir: (p, o) => nodeFs.mkdir(p, o),
  unlink: (p) => nodeFs.unlink(p),
};

export async function writeMarkdown(opts: {
  dir: string; stem: string; sync: SyncMeta; body: string; fs?: FsLike;
}): Promise<string> {
  const fs = opts.fs ?? defaultFs;
  const filename = `${opts.stem}.md`;
  const path = join(opts.dir, filename);
  let llmRaw: string | null = null;
  try {
    const existing = await fs.readFile(path);
    llmRaw = parseExisting(existing).llmRaw;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err; // never silently swallow real read errors
  }
  await fs.mkdir(opts.dir, { recursive: true });
  const content = composeFile(opts.sync, llmRaw, opts.body);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, path);
  return filename;
}

export async function archiveFile(opts: { dir: string; filename: string; fs?: FsLike }): Promise<void> {
  const fs = opts.fs ?? defaultFs;
  const src = join(opts.dir, opts.filename);
  const archiveDir = join(opts.dir, '_Archive');
  let content: string;
  try { content = await fs.readFile(src); } catch (err: any) { if (err.code === 'ENOENT') return; throw err; }
  const updated = content.replace(/removed_from_notion: false/, 'removed_from_notion: true');
  await fs.mkdir(archiveDir, { recursive: true });
  const tmp = join(archiveDir, `${opts.filename}.tmp`);
  await fs.writeFile(tmp, updated);
  await fs.rename(tmp, join(archiveDir, opts.filename));
  await fs.unlink(src); // true move: delete source only AFTER archive copy is safely in place
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/writer.test.ts`
Expected: PASS (2 tests). The llm-preservation test is the critical guarantee.

- [ ] **Step 5: Commit**

```bash
git add src/writer.ts test/writer.test.ts
git commit -m "feat: writer with llm-preserving atomic merge and archive move"
```

---

## Task 11: Discover — two-pass union + dedupe

**Files:**
- Create: `src/discover.ts`, `test/discover.test.ts`

**Interfaces:**
- Consumes: `DiscoveredItem` from `types.ts`.
- Produces: `mergeDiscovery(dbItems: DiscoveredItem[], searchItems: DiscoveredItem[]): DiscoveredItem[]` — union deduped by uuid; when the same uuid appears in both, the DB item wins (keeps `inBacklogDb: true` + properties).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { mergeDiscovery } from '../src/discover.js';
import type { DiscoveredItem } from '../src/types.js';

const mk = (uuid: string, inDb: boolean): DiscoveredItem => ({
  uuid, title: 'T', url: 'u', resultType: 'page', inBacklogDb: inDb, lastEdited: 'x',
  properties: inDb ? { x: 1 } : undefined,
});

test('union dedupes by uuid, DB item wins', () => {
  const merged = mergeDiscovery([mk('a', true)], [mk('a', false), mk('b', false)]);
  expect(merged).toHaveLength(2);
  const a = merged.find((m) => m.uuid === 'a')!;
  expect(a.inBacklogDb).toBe(true);
  expect(a.properties).toEqual({ x: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/discover.test.ts`
Expected: FAIL — cannot find `../src/discover.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { DiscoveredItem } from './types.js';

export function mergeDiscovery(
  dbItems: DiscoveredItem[], searchItems: DiscoveredItem[],
): DiscoveredItem[] {
  const byUuid = new Map<string, DiscoveredItem>();
  for (const it of searchItems) byUuid.set(it.uuid, it);
  for (const it of dbItems) byUuid.set(it.uuid, it); // DB wins (overwrites search)
  return [...byUuid.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/discover.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/discover.ts test/discover.test.ts
git commit -m "feat: discovery union with uuid dedupe (DB wins)"
```

---

## Task 12: Orchestrator — wire the pipeline, summary, exit code

**Files:**
- Create: `src/index.ts`
- Modify: none

**Interfaces:**
- Consumes: every prior module.
- Produces: a runnable CLI (`npm run sync`). No new exported types.

This task wires tested units; it has no new unit test (its parts are all tested). Verification is `npm run typecheck` + the Task 13 smoke run.

- [ ] **Step 1: Write `src/index.ts`**

```ts
import { Client } from '@notionhq/client';
import { join } from 'node:path';
import { loadConfig, readKeychainToken } from './config.js';
import { loadState, saveState, needsSync, findRemoved } from './state.js';
import { enumerateDatabase, searchPrd, resolveUsers } from './notion.js';
import { mergeDiscovery } from './discover.js';
import { classify } from './classify.js';
import { filenameStem } from './naming.js';
import { makeConverter, blocksToMarkdown, normalizeEscapes, resolveNotionLinks, buildSyncMeta } from './convert.js';
import { downloadImages } from './assets.js';
import { writeMarkdown, archiveFile } from './writer.js';
import { mkdir, writeFile } from 'node:fs/promises';

// Image URLs are S3-backed Notion signed URLs that can hang; bound each fetch
// so one stalled download can't block an unattended cron run forever.
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });

async function main(): Promise<number> {
  const cfg = loadConfig(process.env, readKeychainToken);
  const notion = new Client({ auth: cfg.token });
  const n2m = makeConverter(notion);
  const prdsDir = join(cfg.vaultPath, 'PRDs');
  const attachmentsDir = join(prdsDir, '_attachments');
  const state = await loadState(cfg.stateFile);
  const syncedAt = new Date().toISOString();

  // 1. Discover
  const [dbItems, searchItems] = await Promise.all([
    enumerateDatabase(notion, cfg.databaseId),
    searchPrd(notion, cfg.searchTerm),
  ]);
  const items = mergeDiscovery(dbItems, searchItems);
  const presentUuids = new Set(items.map((i) => i.uuid));

  // Precompute handles for wikilink resolution
  const handleByUuid = new Map<string, string>();
  const urlByUuid = new Map<string, string>();
  for (const it of items) {
    const { kind } = classify(it);
    const id = (it.properties as any)?.['ID']?.unique_id;
    const idStr = id ? `${id.prefix ? id.prefix + '-' : ''}${id.number}` : null;
    handleByUuid.set(it.uuid, filenameStem({ kind, id: idStr, title: it.title, uuid: it.uuid }));
    urlByUuid.set(it.uuid, it.url);
  }

  let synced = 0, skipped = 0, archived = 0;
  const errors: string[] = [];

  // 2. Sync each item
  for (const item of items) {
    try {
      if (!needsSync(state.pages[item.uuid], item.lastEdited)) { skipped++; continue; }
      const { kind, canonical } = classify(item);

      let body: string;
      if (kind === 'db-index') {
        body = `# ${item.title}\n\n_Notion database — rows not expanded._\n\n[Open in Notion](${item.url})\n`;
      } else {
        const raw = await blocksToMarkdown(n2m, item.uuid);
        body = resolveNotionLinks(normalizeEscapes(raw), { handleByUuid, urlByUuid });
      }

      // resolve people referenced by this item's properties
      const pic = ((item.properties as any)?.['Product PIC']?.people ?? []).map((p: any) => p.id);
      await resolveUsers(notion, pic, state.users);

      const stem = handleByUuid.get(item.uuid)!;
      body = await downloadImages(body, {
        id: stem, attachmentsDir, vaultRelativePrefix: '_attachments',
        fetchFn: fetchWithTimeout, writeFileFn: (p, d) => writeFile(p, d), mkdirFn: (p) => mkdir(p, { recursive: true }).then(() => {}),
      });

      const sync = buildSyncMeta(item, {
        kind, canonical, userNames: state.users, handleByUuid,
        dependsOnUuids: [], trdRefs: [], syncedAt,
      });
      const filename = await writeMarkdown({ dir: prdsDir, stem, sync, body });
      state.pages[item.uuid] = { id: sync.id, filename, last_edited: item.lastEdited, synced_at: syncedAt, kind };
      synced++;
    } catch (err) {
      errors.push(`${item.title} (${item.uuid}): ${(err as Error).message}`);
    }
  }

  // 3. Archive removed
  for (const uuid of findRemoved(state, presentUuids)) {
    try {
      await archiveFile({ dir: prdsDir, filename: state.pages[uuid].filename });
      archived++;
      delete state.pages[uuid];
    } catch (err) {
      errors.push(`archive ${uuid}: ${(err as Error).message}`);
    }
  }

  await saveState(cfg.stateFile, state);

  console.log(`synced ${synced} · skipped ${skipped} · archived ${archived} · errors ${errors.length}`);
  if (errors.length) { console.error('Errors:\n' + errors.map((e) => '  - ' + e).join('\n')); return 1; }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Fix any signature mismatches against the Interfaces blocks above.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests from Tasks 1–11 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: orchestrator wiring discovery→convert→write→archive"
```

---

## Task 13: Scheduling, README, and live smoke run

**Files:**
- Create: `launchd/com.ringkas.prd-sync.plist`, `README.md`

**Interfaces:** none (operational).

- [ ] **Step 1: Create `launchd/com.ringkas.prd-sync.plist`**

Runs at 08:00, 13:00, 18:00 daily. Replace `<USER>` and `<VAULT_PATH>` before loading.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ringkas.prd-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd /Users/<USER>/Documents/Workspace/Ringkas/Programming/Personal/llm-wiki &amp;&amp; VAULT_PATH="<VAULT_PATH>" /opt/homebrew/bin/npm run sync</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>7</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/tmp/prd-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/prd-sync.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Create `README.md`**

```markdown
# Notion → Obsidian PRD Sync (sub-project A)

One-way sync of Ringkas PRDs from the Notion "Product Backlog (EPIC)" database
into an Obsidian vault as clean Markdown. See `docs/superpowers/specs/` for design.

## Setup (once)
1. Create a Notion internal integration; share it on the "Product Management" page.
2. Store the token: `security add-generic-password -s ringkas-prd-sync -a notion-token -w '<TOKEN>'`

## Run
```bash
VAULT_PATH="/path/to/Obsidian/Vault" npm run sync
```

## Schedule (macOS launchd)
Edit `launchd/com.ringkas.prd-sync.plist` (set `<USER>`, `<VAULT_PATH>`), then:
```bash
cp launchd/com.ringkas.prd-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ringkas.prd-sync.plist
```
Logs: `/tmp/prd-sync.log`, `/tmp/prd-sync.err.log`.

## Output
`PRDs/*.md` (one file per PRD), `PRDs/_attachments/<id>/`, `PRDs/_Archive/`.
`sync.*` frontmatter is owned by this tool; `llm.*` is reserved for enrichment and never overwritten.
```

- [ ] **Step 3: Live smoke run into a throwaway vault**

Run:
```bash
VAULT_PATH="/tmp/smoke-vault" STATE_FILE="/tmp/smoke-state.json" npm run sync
```
Expected: prints `synced N · skipped 0 · archived 0 · errors 0` (N > 0). Exit code 0.

- [ ] **Step 4: Verify a known PRD landed correctly**

Run:
```bash
ls /tmp/smoke-vault/PRDs/ | head
cat /tmp/smoke-vault/PRDs/EP-827-*.md | head -40
```
Expected: file exists; frontmatter has `sync:` with real status/platform + an empty `llm:` block; body has clean `| pipe |` Markdown tables (not `<table>`); any images point at `_attachments/`.

- [ ] **Step 5: Verify idempotency**

Run the same command again:
```bash
VAULT_PATH="/tmp/smoke-vault" STATE_FILE="/tmp/smoke-state.json" npm run sync
```
Expected: `synced 0 · skipped N · archived 0 · errors 0` — nothing re-fetched.

- [ ] **Step 6: Commit**

```bash
git add launchd/com.ringkas.prd-sync.plist README.md
git commit -m "chore: launchd schedule, README, verified smoke run"
```

---

## Self-Review

**Spec coverage check (spec §→ task):**
- §1 decomposition (A only) → plan scoped to A; B/C out of scope (Task list + §9). ✓
- §2 source/columns → Task 7 `buildSyncMeta` maps real columns; Task 9 enumerates DB. ✓
- §3 auth=integration token → Task 2 keychain read. ✓
- §3 stack=Node/notion-to-md → Task 1 deps; Task 7 `makeConverter`. ✓
- §3 discovery=DB+search union → Tasks 9 + 11. ✓
- §3 scope=everything matching PRD, classified → Tasks 6 + 11. ✓
- §3 db results=index list → Task 12 `db-index` body branch. ✓
- §3 archive only on removal → Tasks 3 `findRemoved` + 10 `archiveFile` + 12. ✓
- §3 images downloaded → Task 8. ✓
- §3 schedule launchd → Task 13. ✓
- §5 filename rules (canonical vs satellite) → Task 4. ✓
- §5 frontmatter namespace + merge → Tasks 5 + 10. ✓
- §5 conversion rules (GFM, mention→wikilink, escapes) → Task 7. ✓
- §6 state/incremental/idempotency → Tasks 3 + 12; verified Task 13 step 5. ✓
- §7 error handling (skip-and-continue, atomic, never destroy llm) → Tasks 10 + 12. ✓
- §8 testing (convert + merge fixtures, mocked api, smoke) → Tasks 5,7,9,10,13. ✓
- §10 one-time setup → Prerequisite Checklist. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. ✓

**Type consistency:** `SyncMeta`/`LlmMeta`/`DiscoveredItem`/`SyncState` defined in Task 1 and used consistently. `filenameStem` signature matches between Tasks 4, 12. `writeMarkdown`/`archiveFile` signatures match Tasks 10, 12. `classify` return shape matches Tasks 6, 12. `buildSyncMeta` opts match Tasks 7, 12. ✓

**Known follow-ups (intentionally deferred, not gaps):** `parent`/`sub_items` relation wikilinks and in-body `depends_on` extraction are scaffolded in `SyncMeta` (set to null/[] in Task 7/12) — full relation traversal is a refinement that can land after the core pipeline is green, since it needs the second-pass handle map which Task 12 already builds. Flag for the implementer: wire these once the smoke run confirms the core path.

---

## Task 14: Re-scope discovery (DB-only + body-content filter + API timeout)

**Added 2026-06-18 after the Task 13 live smoke run.** The live run revealed that `/search "PRD"` returns **828** items (tickets/templates/subtasks) and the Product Backlog DB has **715** rows (**423** are "Not Started" stubs). The original "everything matching PRD" scope is unusable. Revised scope (spec §3, revised): **DB rows only, filtered to those with real body content**, with all API calls bounded by a timeout. See the spec's revised Decisions table.

**Files:**
- Modify: `src/index.ts` (drop search pass; construct client with timeout; add content-filter gate before write)
- Create: `src/content.ts` (pure `hasRealContent` helper) + `test/content.test.ts`
- Modify: `src/config.ts` (add `minBodyChars` + `apiTimeoutMs` settings) + `test/config.test.ts`

**Interfaces:**
- Produces: `hasRealContent(markdown: string, minChars: number): boolean` — strips frontmatter-irrelevant whitespace/markdown punctuation and returns true if the meaningful text length ≥ minChars.
- `Config` gains `minBodyChars: number` (default 300) and `apiTimeoutMs: number` (default 30000).

- [ ] **Step 1: Write the failing test for `hasRealContent`** (`test/content.test.ts`)

```ts
import { expect, test } from 'vitest';
import { hasRealContent } from '../src/content.js';

test('empty / whitespace-only body is not real content', () => {
  expect(hasRealContent('', 300)).toBe(false);
  expect(hasRealContent('   \n\n  \t ', 300)).toBe(false);
});

test('a stub heading alone is below threshold', () => {
  expect(hasRealContent('# Title\n\n', 300)).toBe(false);
});

test('a substantial body is real content', () => {
  const body = '# Background\n\n' + 'This PRD describes the disbursement flow in detail. '.repeat(20);
  expect(hasRealContent(body, 300)).toBe(true);
});

test('counts visible text, not markdown punctuation', () => {
  // 250 pipe/dash table-border chars but little real text → below 300
  const tableNoise = '| --- | --- |\n'.repeat(20);
  expect(hasRealContent(tableNoise, 300)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/content.test.ts`
Expected: FAIL — cannot find `../src/content.js`.

- [ ] **Step 3: Implement `src/content.ts`**

```ts
// Decide whether a converted page body has enough real prose to be worth syncing,
// so 'Not Started' backlog stubs (empty bodies) are skipped.
export function hasRealContent(markdown: string, minChars: number): boolean {
  const meaningful = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // drop image embeds
    .replace(/[#>*_`|\-\\]/g, ' ')          // drop markdown punctuation / table borders
    .replace(/\s+/g, ' ')                   // collapse whitespace
    .trim();
  return meaningful.length >= minChars;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/content.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add config settings** (modify `src/config.ts`)

Add to the `Config` interface: `minBodyChars: number;` and `apiTimeoutMs: number;`. In `loadConfig`'s returned object add:
```ts
    minBodyChars: env.MIN_BODY_CHARS ? Number(env.MIN_BODY_CHARS) : 300,
    apiTimeoutMs: env.API_TIMEOUT_MS ? Number(env.API_TIMEOUT_MS) : 30000,
```
Add a test to `test/config.test.ts` asserting the defaults (300 / 30000) and that env overrides parse to numbers.

- [ ] **Step 6: Re-scope the orchestrator** (modify `src/index.ts`)

1. Construct the client with a timeout so block fetches can't hang:
   `const notion = new Client({ auth: cfg.token, timeoutMs: cfg.apiTimeoutMs });`
2. **Drop the search pass.** Discovery becomes DB-only:
   ```ts
   const items = await enumerateDatabase(notion, cfg.databaseId);
   const presentUuids = new Set(items.map((i) => i.uuid));
   ```
   (Remove the `Promise.all([... searchPrd ...])` and the `mergeDiscovery` call. `searchPrd`/`mergeDiscovery` remain exported for potential later use but are no longer called here.)
3. After converting the body (`blocksToMarkdown` → normalize → resolveLinks) and BEFORE downloading images / writing, gate on content:
   ```ts
   if (!hasRealContent(body, cfg.minBodyChars)) { skipped++; continue; }
   ```
   A row that fails the gate is treated like a stub: not written, not added to `state.pages`. (Existing files whose row later drops below threshold are handled by the archive pass — they fall out of `presentUuids`? No: they are still in the DB. So instead: if a previously-synced uuid now fails the content gate, leave its existing file as-is — do NOT delete. Only `findRemoved` archives. A stub that never had content simply is never written.)
4. The `kind === 'db-index'` branch is now dead (no database-type items from DB enumeration) but harmless; leave it.

- [ ] **Step 7: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean; all tests pass (including the new content + config tests).

```bash
git add src/content.ts test/content.test.ts src/config.ts test/config.test.ts src/index.ts
git commit -m "feat: re-scope to DB-only discovery with body-content filter and API timeout"
```

- [ ] **Step 8: Live smoke run (re-verify end to end)**

```bash
rm -rf /tmp/smoke-vault /tmp/smoke-state.json
VAULT_PATH=/tmp/smoke-vault STATE_FILE=/tmp/smoke-state.json npm run sync
```
Expected: completes within a few minutes (not hours), prints `synced N · skipped M · archived 0 · errors E` with a sane N (real PRDs + substantive epics, not 715), and a state file is written. Verify `EP-`-prefixed filenames, clean GFM tables, and that "Not Started" stubs were skipped.
