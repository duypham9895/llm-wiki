# Phase 3 — Pipeline Orchestrator & Run-Manifests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three independent launchd jobs (A sync, B enrich, C index) with one orchestrator that runs them in sequence, has each stage emit a JSON run-manifest, and **halts the chain when a stage fails its health gate** — so a failed enrichment can never silently pass un-enriched PRDs to the index (the 2026-06-19 287/287 incident).

**Architecture:** Each stage writes `<vault>/.runs/<run_id>/<stage>.json` describing what it did. A Node orchestrator (`src/orchestrate.ts`) runs A→B→C as subprocesses, reads each manifest, evaluates a health gate, and stops + alerts on failure. A Python reader (`mcp/prd_mcp/web/manifests.py`) parses manifests for the Status API (Plan A). This plan is **independent of Phase 2 auth** and can be built immediately.

**Tech Stack:** TypeScript (Node ≥22, tsx, vitest) for A/B + orchestrator; Python (pytest) for C's manifest emit + the reader. No new runtime dependencies.

## Global Constraints

- **Node ≥ 22**, ESM (`"type":"module"`); imports use `.js` extensions on relative paths (project convention).
- **Manifest path:** `<vault>/.runs/<run_id>/<stage>.json`; `run_id` is an ISO-8601 UTC timestamp shared across one orchestrated run; `stage` ∈ `sync|enrich|index`.
- **Counter semantics (exact):** `processed` = items attempted this run; `succeeded`; `failed`; `skipped` = unchanged/up-to-date items intentionally untouched (incremental). A no-change night is legitimately `processed=0, failed=0, skipped=N`.
- **Health gates (exit-code first, then ratio only when there is work):**
  - A (sync): PASS iff exit 0 AND `failed <= max_sync_failures` (default 0).
  - B (enrich): PASS iff exit 0 AND (`processed == 0` OR `failed == 0` OR `succeeded/processed >= min_success_ratio` (default 0.5)).
  - C (index): runs only if A and B passed; PASS iff exit 0 AND resulting index non-empty.
- **No division by zero:** the B ratio is evaluated only when `processed > 0`.
- **On any gate failure:** orchestrator does NOT run later stages, writes a summary manifest, exits non-zero, and fires the `OnFailure` alert path (deploy-time systemd unit; the orchestrator's job is the non-zero exit + a success-ping for the dead-man monitor).
- **Secrets on Linux:** A and B currently read macOS keychain via `execFileSync('security',...)` in `src/config.ts` `readKeychainToken()` and `src/enrich/enrich-config.ts` `readEnrichKey()`. The orchestrator runs them as subprocesses; the env-backed reader swap is **Task 7** (required for the VPS, out of scope for local dev runs on the Mac).
- **TDD, frequent commits.** No live Notion/LLM/Chroma calls in tests — use temp dirs and fakes.

---

## File Structure

- `src/manifest.ts` — NEW. Manifest types + `writeManifest(vaultPath, runId, stage, data)` + `readManifest(...)`. Pure I/O over `.runs/`.
- `src/index.ts` — MODIFY. After the run, emit a `sync` manifest (counts from existing `synced/skipped/archived/errors`).
- `src/enrich/enrich-index.ts` — MODIFY. Emit an `enrich` manifest (`processed = enriched + summarize-failures`, `succeeded = enriched`, `skipped`, `failed`).
- `src/enrich/enrich-index.ts` counting — the existing loop tracks `enriched/skipped`; add explicit `failed` (summarize errors) so the manifest is precise.
- `mcp/prd_mcp/index.py` — MODIFY. `run_index` already returns counts; add an opt-in manifest write (or return enough for the CLI to write it).
- `mcp/prd_mcp/cli.py` — MODIFY. The `index` subcommand writes the `index` manifest after `run_index`.
- `src/gate.ts` — NEW. Pure gate functions: `syncGate`, `enrichGate`, `indexGate` over manifest data → `{passed, reason}`. No I/O (unit-test heaven).
- `src/orchestrate.ts` — NEW. Sequences A→B→C as subprocesses, reads manifests, applies gates, writes the summary manifest, exits non-zero on halt, pings the dead-man URL on full success.
- `mcp/prd_mcp/web/manifests.py` — NEW. `read_latest_run(vault_path)` + `read_run_history(vault_path, limit)` for the Status API (Plan A consumes this). Tolerates missing/partial `.runs/`.
- Tests: `test/manifest.test.ts`, `test/gate.test.ts`, `test/orchestrate.test.ts`, `mcp/tests/test_manifests.py`, plus additions to `test/enrich/enrich-index.test.ts` and `mcp/tests/test_index.py`.

---

### Task 1: Manifest I/O (`src/manifest.ts`)

**Files:**
- Create: `src/manifest.ts`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface StageCounts { processed: number; succeeded: number; failed: number; skipped: number }`
  - `interface StageManifest { stage: 'sync'|'enrich'|'index'; run_id: string; started_at: string; finished_at: string; ok: boolean; exit_code: number; counts: StageCounts; errors: string[]; health_gate?: { passed: boolean; reason: string }; extra?: Record<string, unknown> }` (the spec §6 manifest contract includes the gate verdict; stages write the manifest with `health_gate` absent, and the orchestrator records each stage's gate verdict in the summary — Codex #6)
  - `async function writeManifest(vaultPath: string, runId: string, m: StageManifest): Promise<string>` (returns the written path; creates `.runs/<run_id>/` recursively; writes `<stage>.json` pretty-printed)
  - `async function readManifest(vaultPath: string, runId: string, stage: string): Promise<StageManifest | null>` (null if absent/unparseable)

- [ ] **Step 1: Write the failing test**

```typescript
// test/manifest.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeManifest, readManifest, type StageManifest } from '../src/manifest.js';

function sample(stage: StageManifest['stage']): StageManifest {
  return {
    stage, run_id: '2026-06-20T03:00:00.000Z',
    started_at: '2026-06-20T03:00:00.000Z', finished_at: '2026-06-20T03:01:00.000Z',
    ok: true, exit_code: 0,
    counts: { processed: 5, succeeded: 5, failed: 0, skipped: 282 }, errors: [],
  };
}

describe('manifest I/O', () => {
  it('writes a manifest to .runs/<run_id>/<stage>.json and reads it back', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'vault-'));
    const m = sample('enrich');
    const path = await writeManifest(vault, m.run_id, m);
    expect(path).toContain(join('.runs', m.run_id, 'enrich.json'));
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.counts.succeeded).toBe(5);
    const back = await readManifest(vault, m.run_id, 'enrich');
    expect(back).toEqual(m);
  });

  it('returns null for a missing manifest', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'vault-'));
    expect(await readManifest(vault, 'nope', 'sync')).toBeNull();
  });

  it('returns null for an unparseable manifest', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'vault-'));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(vault, '.runs', 'r1'), { recursive: true });
    await writeFile(join(vault, '.runs', 'r1', 'sync.json'), '{ not json', 'utf8');
    expect(await readManifest(vault, 'r1', 'sync')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- manifest`
Expected: FAIL — cannot resolve `../src/manifest.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/manifest.ts
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface StageCounts { processed: number; succeeded: number; failed: number; skipped: number }

export interface GateVerdict { passed: boolean; reason: string }

export interface StageManifest {
  stage: 'sync' | 'enrich' | 'index' | 'summary';
  run_id: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  exit_code: number;
  counts: StageCounts;
  errors: string[];
  health_gate?: GateVerdict;       // spec §6 manifest contract; set by the orchestrator
  extra?: Record<string, unknown>;
}

function runDir(vaultPath: string, runId: string): string {
  return join(vaultPath, '.runs', runId);
}

export async function writeManifest(vaultPath: string, runId: string, m: StageManifest): Promise<string> {
  const dir = runDir(vaultPath, runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${m.stage}.json`);
  await writeFile(path, JSON.stringify(m, null, 2), 'utf8');
  return path;
}

export async function readManifest(vaultPath: string, runId: string, stage: string): Promise<StageManifest | null> {
  try {
    const raw = await readFile(join(runDir(vaultPath, runId), `${stage}.json`), 'utf8');
    return JSON.parse(raw) as StageManifest;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- manifest`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/manifest.ts test/manifest.test.ts
git commit -m "feat(pipeline): run-manifest I/O over .runs/<run_id>/<stage>.json"
```

---

### Task 2: Health gates (`src/gate.ts`)

**Files:**
- Create: `src/gate.ts`
- Test: `test/gate.test.ts`

**Interfaces:**
- Consumes: `StageManifest`, `StageCounts` from `src/manifest.js`.
- Produces:
  - `interface GateResult { passed: boolean; reason: string }`
  - `function syncGate(m: StageManifest, maxSyncFailures?: number): GateResult` (default 0)
  - `function enrichGate(m: StageManifest, minSuccessRatio?: number): GateResult` (default 0.5)
  - `function indexGate(m: StageManifest, indexNonEmpty: boolean): GateResult`

- [ ] **Step 1: Write the failing test**

```typescript
// test/gate.test.ts
import { describe, it, expect } from 'vitest';
import { syncGate, enrichGate, indexGate } from '../src/gate.js';
import type { StageManifest } from '../src/manifest.js';

function m(stage: StageManifest['stage'], exit: number, c: Partial<StageManifest['counts']>): StageManifest {
  return {
    stage, run_id: 'r', started_at: 'a', finished_at: 'b', ok: exit === 0, exit_code: exit,
    counts: { processed: 0, succeeded: 0, failed: 0, skipped: 0, ...c }, errors: [],
  };
}

describe('syncGate', () => {
  it('passes on exit 0 with no failures', () => expect(syncGate(m('sync', 0, { processed: 3, succeeded: 3 })).passed).toBe(true));
  it('fails on nonzero exit', () => expect(syncGate(m('sync', 1, {})).passed).toBe(false));
  it('fails when failures exceed the threshold', () => expect(syncGate(m('sync', 0, { failed: 1 })).passed).toBe(false));
  it('tolerates failures up to maxSyncFailures', () => expect(syncGate(m('sync', 0, { failed: 2 }), 2).passed).toBe(true));
});

describe('enrichGate (the 287/287 incident)', () => {
  it('FAILS the 0/287 case', () => expect(enrichGate(m('enrich', 0, { processed: 287, succeeded: 0, failed: 287 })).passed).toBe(false));
  it('PASSES a no-op night (processed=0) with no division by zero', () => {
    const r = enrichGate(m('enrich', 0, { processed: 0, skipped: 287 }));
    expect(r.passed).toBe(true);
    expect(r.reason).not.toContain('NaN');
  });
  it('PASSES when ratio >= 0.5', () => expect(enrichGate(m('enrich', 0, { processed: 10, succeeded: 6, failed: 4 })).passed).toBe(true));
  it('FAILS when ratio < 0.5', () => expect(enrichGate(m('enrich', 0, { processed: 10, succeeded: 4, failed: 6 })).passed).toBe(false));
  it('fails on nonzero exit regardless of counts', () => expect(enrichGate(m('enrich', 1, { processed: 10, succeeded: 10 })).passed).toBe(false));
});

describe('indexGate', () => {
  it('passes on exit 0 and non-empty index', () => expect(indexGate(m('index', 0, { processed: 5 }), true).passed).toBe(true));
  it('fails on empty index', () => expect(indexGate(m('index', 0, { processed: 5 }), false).passed).toBe(false));
  it('fails on nonzero exit', () => expect(indexGate(m('index', 1, {}), true).passed).toBe(false));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- gate`
Expected: FAIL — cannot resolve `../src/gate.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/gate.ts
import type { StageManifest } from './manifest.js';

export interface GateResult { passed: boolean; reason: string }

export function syncGate(m: StageManifest, maxSyncFailures = 0): GateResult {
  if (m.exit_code !== 0) return { passed: false, reason: `sync exited ${m.exit_code}` };
  if (m.counts.failed > maxSyncFailures)
    return { passed: false, reason: `sync failed ${m.counts.failed} > max ${maxSyncFailures}` };
  return { passed: true, reason: 'sync ok' };
}

export function enrichGate(m: StageManifest, minSuccessRatio = 0.5): GateResult {
  if (m.exit_code !== 0) return { passed: false, reason: `enrich exited ${m.exit_code}` };
  const { processed, succeeded, failed } = m.counts;
  if (processed === 0) return { passed: true, reason: 'enrich no-op (nothing to enrich)' };
  if (failed === 0) return { passed: true, reason: 'enrich ok (no failures)' };
  const ratio = succeeded / processed;
  if (ratio >= minSuccessRatio) return { passed: true, reason: `enrich ok (${succeeded}/${processed})` };
  return { passed: false, reason: `enrich ${succeeded}/${processed} (ratio ${ratio.toFixed(2)} < ${minSuccessRatio})` };
}

export function indexGate(m: StageManifest, indexNonEmpty: boolean): GateResult {
  if (m.exit_code !== 0) return { passed: false, reason: `index exited ${m.exit_code}` };
  if (!indexNonEmpty) return { passed: false, reason: 'index is empty after run' };
  return { passed: true, reason: 'index ok' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- gate`
Expected: PASS (all gate tests, including the 287/287 regression and the processed=0 no-op).

- [ ] **Step 5: Commit**

```bash
git add src/gate.ts test/gate.test.ts
git commit -m "feat(pipeline): health gates (exit-first; B no-op + div-zero safe; 287/287 regression)"
```

---

### Task 3: A (sync) emits a manifest

**Files:**
- Modify: `src/index.ts:105-109` (the tail, after `saveState`, before the final returns)
- Test: `test/manifest-sync.test.ts` (new — tests the manifest-shaping helper in isolation)

**Interfaces:**
- Consumes: `writeManifest`, `StageManifest` from `src/manifest.js`.
- Produces: `function buildSyncManifest(runId, startedAt, finishedAt, counts, errors): StageManifest` exported from `src/index.ts` (pure; testable without running the whole sync).

**Note:** `src/index.ts`'s `main()` does live Notion work, so we do NOT test `main()`. We extract a pure `buildSyncManifest` and unit-test that; wiring it into `main()` is a mechanical change verified by the typecheck + a manual run. **Codex blocker #1:** `src/index.ts` currently calls `main()` unconditionally at module top-level (`src/index.ts:112`), so merely *importing* `buildSyncManifest` in a test would start a live Notion sync. Step 1 below adds an ESM entrypoint guard BEFORE we add the export, so the import is side-effect-free.

**Counter semantics (Codex #7) — additive:** sync attempts both page writes AND archive deletions, and may error. Counts must satisfy `processed == succeeded + failed`: `processed = synced + archived + errors.length`, `succeeded = synced + archived`, `failed = errors.length`, `skipped = skipped`.

- [ ] **Step 1: Guard the existing top-level `main()` call (so importing the module is side-effect-free)**

In `src/index.ts`, replace the final line:

```typescript
main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
```

with an entrypoint-guarded version:

```typescript
// Only run the pipeline when executed directly, NOT when imported by a test.
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// test/manifest-sync.test.ts
import { describe, it, expect } from 'vitest';
import { buildSyncManifest } from '../src/index.js';

describe('buildSyncManifest', () => {
  it('maps a healthy run with additive counts', () => {
    const m = buildSyncManifest('r1', 'a', 'b', { synced: 3, skipped: 280, archived: 1, errors: [] });
    expect(m.stage).toBe('sync');
    expect(m.counts).toEqual({ processed: 4, succeeded: 4, failed: 0, skipped: 280 });
    expect(m.ok).toBe(true);
    expect(m.exit_code).toBe(0);
    expect(m.extra?.archived).toBe(1);
  });

  it('flags failure and keeps counts additive when there are errors', () => {
    const m = buildSyncManifest('r1', 'a', 'b', { synced: 2, skipped: 1, archived: 1, errors: ['boom'] });
    expect(m.counts).toEqual({ processed: 4, succeeded: 3, failed: 1, skipped: 1 }); // 2 synced + 1 archived + 1 error
    expect(m.ok).toBe(false);
    expect(m.exit_code).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- manifest-sync`
Expected: FAIL — `buildSyncManifest` is not exported. (It must NOT trigger a live sync — the guard from Step 1 ensures that.)

- [ ] **Step 4: Write minimal implementation**

Add to `src/index.ts` (above `main`), and add the import at the top:

```typescript
import { writeManifest, type StageManifest } from './manifest.js';

export function buildSyncManifest(
  runId: string, startedAt: string, finishedAt: string,
  r: { synced: number; skipped: number; archived: number; errors: string[] },
): StageManifest {
  const failed = r.errors.length;
  const succeeded = r.synced + r.archived;
  return {
    stage: 'sync', run_id: runId, started_at: startedAt, finished_at: finishedAt,
    ok: failed === 0, exit_code: failed ? 1 : 0,
    counts: { processed: succeeded + failed, succeeded, failed, skipped: r.skipped },
    errors: r.errors.slice(0, 20), extra: { archived: r.archived },
  };
}
```

Then wire it into `main()` just before the existing `console.log(...)`/returns at `src/index.ts:107`. `main()` must derive a `runId` (read `process.env.RUN_ID` if set by the orchestrator, else generate one):

```typescript
  // near the top of main(), alongside `const syncedAt = new Date().toISOString();`
  const runId = process.env.RUN_ID ?? syncedAt;
  // ... after saveState(...) and before the final console.log/return:
  await writeManifest(cfg.vaultPath, runId, buildSyncManifest(runId, syncedAt, new Date().toISOString(),
    { synced, skipped, archived, errors }));
```

- [ ] **Step 5: Run test + typecheck**

Run: `npm test -- manifest-sync && npm run typecheck`
Expected: tests PASS (and the test run does NOT perform a live sync); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/manifest-sync.test.ts
git commit -m "feat(pipeline): sync (A) emits a run-manifest (entrypoint-guarded, additive counts)"
```

---

### Task 4: B (enrich) tracks `failed` and emits a manifest

**Files:**
- Modify: `src/enrich/enrich-index.ts:49-103` (add a `failed` counter; emit manifest at the tail)
- Test: `test/enrich/manifest-enrich.test.ts` (new — tests the pure builder)

**Interfaces:**
- Consumes: `writeManifest`, `StageManifest` from `src/manifest.js`.
- Produces: `function buildEnrichManifest(runId, startedAt, finishedAt, counts): StageManifest` exported from `src/enrich/enrich-index.ts`.

**Counting rule:** `processed` = docs that *needed* enrichment this run = `enriched + failed` (summarize failures); `succeeded` = `enriched`; `failed` = summarize errors among those; `skipped` = `skipped`. This makes the 287/287 case `processed=287, succeeded=0, failed=287`.

**Codex #1 + #3:** `enrich-index.ts` also calls `main()` at top-level (`src/enrich/enrich-index.ts:107`) → entrypoint guard first. AND the real loop pushes load/write errors into a separate `errors[]` (at lines 42-43, 64-65, 95-96) and exits 1 when `errors.length` (line 102-103). The manifest's `ok`/`exit_code` must reflect `errors.length || failed`, NOT just `failed` — otherwise a run that loaded 0 docs (all load-errors) would report `ok:true`. So `buildEnrichManifest` takes the `errors` array too.

- [ ] **Step 1: Guard the top-level `main()` call**

In `src/enrich/enrich-index.ts`, replace the final line:

```typescript
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
```

with:

```typescript
if (process.argv[1] && process.argv[1].endsWith('enrich-index.ts')) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// test/enrich/manifest-enrich.test.ts
import { describe, it, expect } from 'vitest';
import { buildEnrichManifest } from '../../src/enrich/enrich-index.js';

describe('buildEnrichManifest', () => {
  it('maps a healthy incremental run', () => {
    const m = buildEnrichManifest('r1', 'a', 'b', { enriched: 5, skipped: 282, failed: 0, errors: [], relatedPairs: 12, written: 5 });
    expect(m.stage).toBe('enrich');
    expect(m.counts).toEqual({ processed: 5, succeeded: 5, failed: 0, skipped: 282 });
    expect(m.ok).toBe(true);
    expect(m.exit_code).toBe(0);
  });

  it('maps the 287/287 total-failure (incident)', () => {
    const m = buildEnrichManifest('r1', 'a', 'b', { enriched: 0, skipped: 0, failed: 287, errors: [], relatedPairs: 0, written: 0 });
    expect(m.counts).toEqual({ processed: 287, succeeded: 0, failed: 287, skipped: 0 });
    expect(m.ok).toBe(false);
    expect(m.exit_code).toBe(1);
  });

  it('flags failure when load/write errors occurred even if no summarize failed', () => {
    const m = buildEnrichManifest('r1', 'a', 'b', { enriched: 3, skipped: 1, failed: 0, errors: ['load x: boom'], relatedPairs: 2, written: 3 });
    expect(m.ok).toBe(false);
    expect(m.exit_code).toBe(1);
    expect(m.errors).toContain('load x: boom');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- manifest-enrich`
Expected: FAIL — `buildEnrichManifest` not exported (and the import does NOT run a live enrich, thanks to Step 1).

- [ ] **Step 4: Write minimal implementation**

In `src/enrich/enrich-index.ts`: add `import { writeManifest, type StageManifest } from '../manifest.js';` at the top; add a `let failed = 0;` next to `let enriched = 0, skipped = 0;`; increment `failed++` in the Phase-1 `catch (err)` block that pushes the `summarize ...` error (lines ~67-69). Add the builder:

```typescript
export function buildEnrichManifest(
  runId: string, startedAt: string, finishedAt: string,
  r: { enriched: number; skipped: number; failed: number; errors: string[]; relatedPairs: number; written: number },
): StageManifest {
  const processed = r.enriched + r.failed;
  const bad = r.failed > 0 || r.errors.length > 0;   // summarize failures OR load/write errors
  return {
    stage: 'enrich', run_id: runId, started_at: startedAt, finished_at: finishedAt,
    ok: !bad, exit_code: bad ? 1 : 0,
    counts: { processed, succeeded: r.enriched, failed: r.failed, skipped: r.skipped },
    errors: r.errors.slice(0, 20), extra: { relatedPairs: r.relatedPairs, written: r.written },
  };
}
```

Wire near the tail (around line 102), capturing timestamps at the top of `main()`:

```typescript
  // top of main():
  const startedAt = new Date().toISOString();
  const runId = process.env.RUN_ID ?? startedAt;
  // just before the final console.log/return:
  await writeManifest(cfg.vaultPath, runId,
    buildEnrichManifest(runId, startedAt, new Date().toISOString(),
      { enriched, skipped, failed, errors, relatedPairs, written }));
```

Update the final guard to return 1 when either errors or summarize-failures occurred: `if (errors.length || failed) { console.error(...); return 1; }`.

- [ ] **Step 5: Run test + typecheck**

Run: `npm test -- manifest-enrich && npm run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/enrich/enrich-index.ts test/enrich/manifest-enrich.test.ts
git commit -m "feat(pipeline): enrich (B) emits a run-manifest (entrypoint-guarded; ok reflects errors+failures)"
```

---

### Task 5: C (index) emits a manifest

**Files:**
- Modify: `mcp/prd_mcp/cli.py:43-48` (the `index` subcommand)
- Create: `mcp/prd_mcp/web/manifests.py` (the writer half lives here too, reused by the reader in Task 6)
- Test: `mcp/tests/test_index_manifest.py`

**Interfaces:**
- Consumes: `run_index` result `{indexed, skipped, removed, errors}` (verified in `mcp/prd_mcp/index.py:54`); `store.stored_hashes()` to check non-empty.
- Produces in `manifests.py`:
  - `def write_index_manifest(vault_path: str, run_id: str, started_at: str, finished_at: str, res: dict, index_nonempty: bool) -> str`

**Manifest JSON must match the TS `StageManifest` shape** (same field names) so one reader serves both.

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/test_index_manifest.py
import json, os, tempfile
from prd_mcp.web.manifests import write_index_manifest


def test_write_index_manifest_healthy():
    with tempfile.TemporaryDirectory() as vault:
        path = write_index_manifest(
            vault, "r1", "a", "b",
            {"indexed": 5, "skipped": 282, "removed": 0, "errors": 0}, index_nonempty=True)
        assert path.endswith(os.path.join(".runs", "r1", "index.json"))
        m = json.load(open(path))
        assert m["stage"] == "index"
        assert m["counts"] == {"processed": 5, "succeeded": 5, "failed": 0, "skipped": 282}
        assert m["ok"] is True
        assert m["exit_code"] == 0


def test_write_index_manifest_with_errors():
    with tempfile.TemporaryDirectory() as vault:
        path = write_index_manifest(
            vault, "r1", "a", "b",
            {"indexed": 3, "skipped": 1, "removed": 0, "errors": 2}, index_nonempty=True)
        m = json.load(open(path))
        assert m["counts"]["failed"] == 2
        assert m["ok"] is False
        assert m["exit_code"] == 1


def test_write_index_manifest_empty_index_is_failure():
    # Codex #4: a clean run (0 errors) that leaves an EMPTY index must NOT be exit 0.
    with tempfile.TemporaryDirectory() as vault:
        path = write_index_manifest(
            vault, "r1", "a", "b",
            {"indexed": 0, "skipped": 0, "removed": 0, "errors": 0}, index_nonempty=False)
        m = json.load(open(path))
        assert m["ok"] is False
        assert m["exit_code"] == 1
        assert m["extra"]["index_nonempty"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/test_index_manifest.py -v`
Expected: FAIL — `prd_mcp.web.manifests` has no `write_index_manifest` (module may not exist yet).

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/prd_mcp/web/manifests.py
import json
import os


def write_index_manifest(vault_path: str, run_id: str, started_at: str, finished_at: str,
                         res: dict, index_nonempty: bool) -> str:
    run_dir = os.path.join(vault_path, ".runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    errors = int(res.get("errors", 0))
    indexed = int(res.get("indexed", 0))
    bad = errors > 0 or not index_nonempty   # Codex #4: an empty index is a failure, not exit 0
    manifest = {
        "stage": "index",
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": finished_at,
        "ok": not bad,
        "exit_code": 1 if bad else 0,
        "counts": {
            "processed": indexed,
            "succeeded": indexed,
            "failed": errors,
            "skipped": int(res.get("skipped", 0)),
        },
        "errors": [],
        "extra": {"removed": int(res.get("removed", 0)), "index_nonempty": index_nonempty},
    }
    path = os.path.join(run_dir, "index.json")
    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=2)
    return path
```

Then wire into `cli.py` `index` branch (after `run_index`, using env `RUN_ID` or a generated UTC stamp):

```python
    if args.cmd == "index":
        from datetime import datetime, timezone
        from prd_mcp.web.manifests import write_index_manifest
        llm = make_client(cfg)
        started = datetime.now(timezone.utc).isoformat()
        res = run_index(cfg, store, llm.embed, force=args.force)
        run_id = os.environ.get("RUN_ID", started)
        write_index_manifest(cfg.vault_path, run_id, started,
                             datetime.now(timezone.utc).isoformat(), res,
                             index_nonempty=bool(store.stored_hashes()))
        print(f"indexed {res['indexed']} · skipped {res['skipped']} · "
              f"removed {res['removed']} · errors {res['errors']}")
        return 1 if res["errors"] else 0
```

(`cfg.vault_path` is verified to exist in `config.py:30`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/test_index_manifest.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/web/manifests.py mcp/prd_mcp/cli.py mcp/tests/test_index_manifest.py
git commit -m "feat(pipeline): index (C) emits a run-manifest matching the shared shape"
```

---

### Task 5b: Python env-backed secret reader for C (Linux/VPS)

**Files:**
- Create: `mcp/prd_mcp/env_secret.py`
- Modify: `mcp/prd_mcp/cli.py:40` (select the reader by `PRD_SECRETS`)
- Test: `mcp/tests/test_env_secret.py`

**Interfaces:**
- Consumes: nothing (leaf). Mirrors `read_secret(service, account)` from `mcp/prd_mcp/keychain.py` (verified: it shells out to the macOS `security` CLI, so it fails on Linux).
- Produces: `def read_secret_from_env(service: str, account: str) -> str` — maps the (service, account) pairs the core actually uses to env vars and returns the value, raising a clear error if missing.

**Codex #2 + spec §8:** `load_config(os.environ, read_secret)` in `cli.py:40` uses the keychain reader. The core requests exactly two secrets (verified in `config.py:32,35`): `read_secret("ringkas-prd-embed", "openai-api-key")` and `read_secret("ringkas-prd-enrich", "llm-api-key")`. The env reader maps those to `OPENAI_API_KEY` and `LLM_API_KEY`.

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/test_env_secret.py
import pytest
from prd_mcp.env_secret import read_secret_from_env


def test_maps_known_service_account_pairs(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "embed-key")
    monkeypatch.setenv("LLM_API_KEY", "chat-key")
    assert read_secret_from_env("ringkas-prd-embed", "openai-api-key") == "embed-key"
    assert read_secret_from_env("ringkas-prd-enrich", "llm-api-key") == "chat-key"


def test_missing_env_raises_clearly(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        read_secret_from_env("ringkas-prd-embed", "openai-api-key")


def test_unknown_pair_raises(monkeypatch):
    with pytest.raises(KeyError):
        read_secret_from_env("unknown-service", "unknown-account")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/test_env_secret.py -v`
Expected: FAIL — module `prd_mcp.env_secret` does not exist.

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/prd_mcp/env_secret.py
import os

# (service, account) -> env var name. These are the only secrets the core requests
# (see config.py load_config: ringkas-prd-embed/openai-api-key, ringkas-prd-enrich/llm-api-key).
_ENV_BY_PAIR = {
    ("ringkas-prd-embed", "openai-api-key"): "OPENAI_API_KEY",
    ("ringkas-prd-enrich", "llm-api-key"): "LLM_API_KEY",
}


def read_secret_from_env(service: str, account: str) -> str:
    """Env-backed replacement for keychain.read_secret on Linux (PRD_SECRETS=env)."""
    var = _ENV_BY_PAIR[(service, account)]  # KeyError on an unknown pair = programmer error
    val = os.environ.get(var)
    if not val:
        raise ValueError(f"{var} env var is required (PRD_SECRETS=env mode)")
    return val
```

Then select it in `cli.py` (replace the single `load_config(os.environ, read_secret)` at line 40):

```python
    # index/serve require the LLM/embed secrets:
    if os.environ.get("PRD_SECRETS") == "env":
        from prd_mcp.env_secret import read_secret_from_env as secret_reader
    else:
        secret_reader = read_secret
    cfg = load_config(os.environ, secret_reader)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/test_env_secret.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/env_secret.py mcp/prd_mcp/cli.py mcp/tests/test_env_secret.py
git commit -m "feat(pipeline): env-backed secret reader for C (PRD_SECRETS=env) on Linux"
```

---

### Task 6: Manifest reader for the Status API (`manifests.py` read side)

**Files:**
- Modify: `mcp/prd_mcp/web/manifests.py` (add the read functions)
- Test: `mcp/tests/test_manifests.py`

**Interfaces:**
- Consumes: manifest JSON files written by Tasks 3–5.
- Produces:
  - `def read_latest_run(vault_path: str) -> dict | None` — newest `.runs/<run_id>/` by name (run_ids are ISO timestamps → lexically sortable); returns `{run_id, stages: {sync?, enrich?, index?}, halted: bool, halt_reason: str|None, halted_at: str|None}` (reads the orchestrator's `summary.json`; its halt fields live under `extra` because summary uses the shared manifest shape — Codex #5; absent → infer halted from a missing/failed downstream stage). Returns None if `.runs/` is absent/empty.
  - `def read_run_history(vault_path: str, limit: int = 10) -> list[dict]` — newest-first list of `{run_id, ok, stage_count}`.

**Tolerance:** a missing `.runs/`, an empty dir, or a partial run must NOT raise — Status shows "no run data yet".

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/test_manifests.py
import json, os, tempfile
from prd_mcp.web.manifests import read_latest_run, read_run_history


def _write(vault, run_id, stage, ok=True):
    d = os.path.join(vault, ".runs", run_id)
    os.makedirs(d, exist_ok=True)
    json.dump({"stage": stage, "run_id": run_id, "ok": ok, "exit_code": 0 if ok else 1,
               "counts": {"processed": 1, "succeeded": 1, "failed": 0, "skipped": 0},
               "errors": [], "started_at": "a", "finished_at": "b"},
              open(os.path.join(d, f"{stage}.json"), "w"))


def test_no_runs_dir_returns_none_and_empty():
    with tempfile.TemporaryDirectory() as vault:
        assert read_latest_run(vault) is None
        assert read_run_history(vault) == []


def test_latest_run_picks_newest_and_collects_stages():
    with tempfile.TemporaryDirectory() as vault:
        for s in ("sync", "enrich", "index"):
            _write(vault, "2026-06-19T03:00:00Z", s)
        _write(vault, "2026-06-20T03:00:00Z", "sync")
        _write(vault, "2026-06-20T03:00:00Z", "enrich")
        latest = read_latest_run(vault)
        assert latest["run_id"] == "2026-06-20T03:00:00Z"
        assert set(latest["stages"]) == {"sync", "enrich"}  # index missing -> halted inferred
        assert latest["halted"] is True


def test_history_newest_first_limited():
    with tempfile.TemporaryDirectory() as vault:
        for day in ("18", "19", "20"):
            _write(vault, f"2026-06-{day}T03:00:00Z", "sync")
        hist = read_run_history(vault, limit=2)
        assert [h["run_id"] for h in hist] == ["2026-06-20T03:00:00Z", "2026-06-19T03:00:00Z"]


def test_summary_halt_reason_round_trips_from_extra():
    # Codex #5: orchestrator writes halt fields under extra; reader must surface them.
    with tempfile.TemporaryDirectory() as vault:
        rid = "2026-06-20T03:00:00Z"
        _write(vault, rid, "sync")
        _write(vault, rid, "enrich", ok=False)
        d = os.path.join(vault, ".runs", rid)
        json.dump({"stage": "summary", "run_id": rid, "ok": False, "exit_code": 1,
                   "counts": {"processed": 0, "succeeded": 0, "failed": 0, "skipped": 0}, "errors": [],
                   "extra": {"halted": True, "halt_reason": "enrich 0/287 (ratio 0.00 < 0.5)", "halted_at": "enrich"}},
                  open(os.path.join(d, "summary.json"), "w"))
        latest = read_latest_run(vault)
        assert latest["halted"] is True
        assert latest["halt_reason"] == "enrich 0/287 (ratio 0.00 < 0.5)"
        assert latest["halted_at"] == "enrich"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && .venv/bin/pytest tests/test_manifests.py -v`
Expected: FAIL — `read_latest_run`/`read_run_history` not defined.

- [ ] **Step 3: Write minimal implementation**

```python
# add to mcp/prd_mcp/web/manifests.py
STAGES = ("sync", "enrich", "index")


def _runs_dir(vault_path: str) -> str:
    return os.path.join(vault_path, ".runs")


def _list_run_ids(vault_path: str) -> list[str]:
    d = _runs_dir(vault_path)
    if not os.path.isdir(d):
        return []
    return sorted((name for name in os.listdir(d) if os.path.isdir(os.path.join(d, name))), reverse=True)


def _read_stage(vault_path: str, run_id: str, stage: str) -> dict | None:
    try:
        with open(os.path.join(_runs_dir(vault_path), run_id, f"{stage}.json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def read_latest_run(vault_path: str) -> dict | None:
    ids = _list_run_ids(vault_path)
    if not ids:
        return None
    run_id = ids[0]
    stages = {s: m for s in STAGES if (m := _read_stage(vault_path, run_id, s)) is not None}
    summary = _read_stage(vault_path, run_id, "summary") or {}
    # The orchestrator writes halt fields under `extra` (summary uses the shared manifest shape) — Codex #5.
    sx = summary.get("extra") or {}
    halted = sx.get("halted")
    halt_reason = sx.get("halt_reason")
    halted_at = sx.get("halted_at")
    if halted is None:
        # No summary yet: infer a halt if any stage is missing OR any present stage is not ok.
        halted = (len(stages) < len(STAGES)) or any(not m.get("ok", False) for m in stages.values())
        if halted and halt_reason is None:
            bad = next((s for s in STAGES if s not in stages or not stages[s].get("ok", False)), None)
            halt_reason = f"stage '{bad}' did not complete successfully" if bad else None
            halted_at = bad
    return {"run_id": run_id, "stages": stages, "halted": bool(halted),
            "halt_reason": halt_reason, "halted_at": halted_at}


def read_run_history(vault_path: str, limit: int = 10) -> list[dict]:
    out = []
    for run_id in _list_run_ids(vault_path)[:limit]:
        stages = [s for s in STAGES if _read_stage(vault_path, run_id, s) is not None]
        ok = all((m := _read_stage(vault_path, run_id, s)) and m.get("ok") for s in stages) if stages else False
        out.append({"run_id": run_id, "ok": ok, "stage_count": len(stages)})
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && .venv/bin/pytest tests/test_manifests.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/web/manifests.py mcp/tests/test_manifests.py
git commit -m "feat(pipeline): manifest reader (latest run + history) for the Status API"
```

---

### Task 7: Env-backed secret readers for Linux (A + B)

**Files:**
- Modify: `src/config.ts:15-21` (add an env-backed reader alongside `readKeychainToken`)
- Modify: `src/enrich/enrich-config.ts:4-10` (add an env-backed reader alongside `readEnrichKey`)
- Modify: `src/index.ts` (pick reader by env), `src/enrich/enrich-index.ts` (pick reader by env)
- Test: `test/config.test.ts` (add cases), `test/enrich/enrich-config.test.ts` (add cases)

**Interfaces:**
- Produces: `function readNotionTokenFromEnv(env: NodeJS.ProcessEnv): string` in `config.ts`; `function readEnrichKeyFromEnv(env: NodeJS.ProcessEnv): string` in `enrich-config.ts`. Both throw a clear error if the var is missing/empty.

**Selection rule:** the entrypoints choose the env reader when `PRD_SECRETS=env` (set on the VPS), else the existing keychain reader (Mac default). `loadConfig`/`loadEnrichConfig` already take the reader as a param (verified at `src/config.ts:23` and `src/enrich/enrich-config.ts:12`), so this is purely an injection swap.

- [ ] **Step 1: Write the failing test**

```typescript
// add to test/config.test.ts
import { readNotionTokenFromEnv } from '../src/config.js';
import { describe, it, expect } from 'vitest';

describe('readNotionTokenFromEnv', () => {
  it('returns NOTION_TOKEN from env', () => {
    expect(readNotionTokenFromEnv({ NOTION_TOKEN: 'secret-123' } as any)).toBe('secret-123');
  });
  it('throws when NOTION_TOKEN is missing', () => {
    expect(() => readNotionTokenFromEnv({} as any)).toThrow(/NOTION_TOKEN/);
  });
});
```

```typescript
// add to test/enrich/enrich-config.test.ts
import { readEnrichKeyFromEnv } from '../../src/enrich/enrich-config.js';
import { describe, it, expect } from 'vitest';

describe('readEnrichKeyFromEnv', () => {
  it('returns LLM_API_KEY from env', () => {
    expect(readEnrichKeyFromEnv({ LLM_API_KEY: 'k-1' } as any)).toBe('k-1');
  });
  it('throws when LLM_API_KEY is missing', () => {
    expect(() => readEnrichKeyFromEnv({} as any)).toThrow(/LLM_API_KEY/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- config`
Expected: FAIL — `readNotionTokenFromEnv` / `readEnrichKeyFromEnv` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/config.ts — add:
export function readNotionTokenFromEnv(env: NodeJS.ProcessEnv): string {
  const t = env.NOTION_TOKEN;
  if (!t) throw new Error('NOTION_TOKEN env var is required (PRD_SECRETS=env mode)');
  return t;
}
```

```typescript
// src/enrich/enrich-config.ts — add:
export function readEnrichKeyFromEnv(env: NodeJS.ProcessEnv): string {
  const k = env.LLM_API_KEY;
  if (!k) throw new Error('LLM_API_KEY env var is required (PRD_SECRETS=env mode)');
  return k;
}
```

Wire the selection at each entrypoint:

```typescript
// src/index.ts — replace `loadConfig(process.env, readKeychainToken)`:
import { loadConfig, readKeychainToken, readNotionTokenFromEnv } from './config.js';
const reader = process.env.PRD_SECRETS === 'env'
  ? () => readNotionTokenFromEnv(process.env)
  : readKeychainToken;
const cfg = loadConfig(process.env, reader);
```

```typescript
// src/enrich/enrich-index.ts — replace `loadEnrichConfig(process.env, readEnrichKey)`:
import { loadEnrichConfig, readEnrichKey, readEnrichKeyFromEnv } from './enrich-config.js';
const reader = process.env.PRD_SECRETS === 'env'
  ? () => readEnrichKeyFromEnv(process.env)
  : readEnrichKey;
const cfg = loadEnrichConfig(process.env, reader);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- config && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/enrich/enrich-config.ts src/index.ts src/enrich/enrich-index.ts test/config.test.ts test/enrich/enrich-config.test.ts
git commit -m "feat(pipeline): env-backed secret readers (PRD_SECRETS=env) for Linux/VPS"
```

---

### Task 8: The orchestrator (`src/orchestrate.ts`)

**Files:**
- Create: `src/orchestrate.ts`
- Test: `test/orchestrate.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `writeManifest`, `StageManifest`, `GateVerdict` (`src/manifest.js`); `syncGate`, `enrichGate`, `indexGate`, `GateResult` (`src/gate.js`).
- Produces:
  - `interface StageRunner { (runId: string): Promise<{ exitCode: number }> }`
  - `async function orchestrate(opts: { vaultPath: string; runId: string; runners: { sync: StageRunner; enrich: StageRunner; index: StageRunner }; onSuccessPing?: () => Promise<void>; maxSyncFailures?: number; minSuccessRatio?: number }): Promise<{ halted: boolean; haltedAt?: 'sync'|'enrich'|'index'; reason: string }>`

**Design:** `orchestrate` is dependency-injected with stage *runners* (so tests pass fakes; production passes runners that `spawn` the real `npm run sync` / `npm run enrich` / `prd-mcp index` subprocesses with `RUN_ID` in env). After each runner it reads that stage's manifest, applies the gate, and HALTS (writing a `summary.json` and returning) on failure. Three correctness rules from Codex review:
- **(#3) Exit-code reconciliation:** the runner returns `{exitCode}` AND the stage writes `exit_code` in its manifest. If they DISAGREE (e.g. the process crashed before writing, or wrote `ok:true` but exited nonzero), treat the stage as FAILED — never trust one over the other.
- **(#4) `index_nonempty` comes from the index manifest's `extra.index_nonempty`** (written by Task 5 from the real `store.stored_hashes()`), NOT a caller-supplied boolean. This removes Task 9's hardcoded-`true` bypass.
- **(#6) Gate verdicts are recorded** per stage in the summary manifest's `extra.gates` so the Status API (Plan A) can show why a run halted.
Only on all-pass does it call `onSuccessPing` (the dead-man monitor) — Task 9 wires the real ping.

- [ ] **Step 1: Write the failing test**

```typescript
// test/orchestrate.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrate, type StageRunner } from '../src/orchestrate.js';
import { writeManifest, readManifest, type StageManifest } from '../src/manifest.js';

function counts(c: Partial<StageManifest['counts']>) {
  return { processed: 0, succeeded: 0, failed: 0, skipped: 0, ...c };
}
// a runner that writes a manifest for its stage then reports an exit code.
// `extra` lets the index stage advertise index_nonempty; `manifestExit` lets a test
// force a disagreement between the written manifest and the returned exitCode.
function runnerWriting(
  vault: string, stage: StageManifest['stage'], exit: number, c: Partial<StageManifest['counts']>,
  extra?: Record<string, unknown>, manifestExit?: number,
): StageRunner {
  return async (runId: string) => {
    const ec = manifestExit ?? exit;
    await writeManifest(vault, runId, {
      stage, run_id: runId, started_at: 'a', finished_at: 'b', ok: ec === 0, exit_code: ec,
      counts: counts(c), errors: [], extra,
    });
    return { exitCode: exit };
  };
}

describe('orchestrate', () => {
  it('runs all three and pings on full success', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'v-'));
    const ping = vi.fn(async () => {});
    const res = await orchestrate({
      vaultPath: vault, runId: 'r1',
      runners: {
        sync: runnerWriting(vault, 'sync', 0, { processed: 3, succeeded: 3 }),
        enrich: runnerWriting(vault, 'enrich', 0, { processed: 2, succeeded: 2 }),
        index: runnerWriting(vault, 'index', 0, { processed: 2, succeeded: 2 }, { index_nonempty: true }),
      },
      onSuccessPing: ping,
    });
    expect(res.halted).toBe(false);
    expect(ping).toHaveBeenCalledOnce();
    // gate verdicts recorded in the summary (Codex #6)
    const summary = await readManifest(vault, 'r1', 'summary' as any);
    expect((summary!.extra as any).gates.enrich.passed).toBe(true);
  });

  it('HALTS at enrich on the 287/287 case and never runs index', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'v-'));
    const ping = vi.fn(async () => {});
    const indexRunner = vi.fn(runnerWriting(vault, 'index', 0, { processed: 1, succeeded: 1 }, { index_nonempty: true }));
    const res = await orchestrate({
      vaultPath: vault, runId: 'r2',
      runners: {
        sync: runnerWriting(vault, 'sync', 0, { processed: 0, skipped: 287 }),
        enrich: runnerWriting(vault, 'enrich', 1, { processed: 287, succeeded: 0, failed: 287 }),
        index: indexRunner,
      },
      onSuccessPing: ping,
    });
    expect(res.halted).toBe(true);
    expect(res.haltedAt).toBe('enrich');
    expect(indexRunner).not.toHaveBeenCalled();   // C never ran — the incident fix
    expect(ping).not.toHaveBeenCalled();           // no success ping on a halt
    const summary = await readManifest(vault, 'r2', 'summary' as any);
    expect(summary).not.toBeNull();
    expect((summary!.extra as any).halted).toBe(true);
    expect((summary!.extra as any).halt_reason).toContain('enrich');
  });

  it('HALTS at sync when sync fails and never runs enrich/index', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'v-'));
    const enrichRunner = vi.fn(runnerWriting(vault, 'enrich', 0, { processed: 1, succeeded: 1 }));
    const res = await orchestrate({
      vaultPath: vault, runId: 'r3',
      runners: {
        sync: runnerWriting(vault, 'sync', 1, { failed: 1 }),
        enrich: enrichRunner,
        index: runnerWriting(vault, 'index', 0, {}, { index_nonempty: true }),
      },
    });
    expect(res.halted).toBe(true);
    expect(res.haltedAt).toBe('sync');
    expect(enrichRunner).not.toHaveBeenCalled();
  });

  it('HALTS at index when the index is empty (Codex #4 — no bypass)', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'v-'));
    const res = await orchestrate({
      vaultPath: vault, runId: 'r4',
      runners: {
        sync: runnerWriting(vault, 'sync', 0, { processed: 1, succeeded: 1 }),
        enrich: runnerWriting(vault, 'enrich', 0, { processed: 1, succeeded: 1 }),
        index: runnerWriting(vault, 'index', 0, { processed: 0 }, { index_nonempty: false }),
      },
    });
    expect(res.halted).toBe(true);
    expect(res.haltedAt).toBe('index');
  });

  it('HALTS when a runner exit code disagrees with its manifest (Codex #3)', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'v-'));
    const enrichRunner = vi.fn(runnerWriting(vault, 'enrich', 0, { processed: 1, succeeded: 1 }));
    // sync runner exits 1 but (bug-simulating) writes a manifest claiming exit_code 0
    const res = await orchestrate({
      vaultPath: vault, runId: 'r5',
      runners: {
        sync: runnerWriting(vault, 'sync', 1, { processed: 1, succeeded: 1 }, undefined, 0),
        enrich: enrichRunner,
        index: runnerWriting(vault, 'index', 0, {}, { index_nonempty: true }),
      },
    });
    expect(res.halted).toBe(true);
    expect(res.haltedAt).toBe('sync');
    expect(enrichRunner).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orchestrate`
Expected: FAIL — cannot resolve `../src/orchestrate.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestrate.ts
import { readManifest, writeManifest, type StageManifest, type GateVerdict } from './manifest.js';
import { syncGate, enrichGate, indexGate } from './gate.js';

export interface StageRunner { (runId: string): Promise<{ exitCode: number }> }

export interface OrchestrateOpts {
  vaultPath: string;
  runId: string;
  runners: { sync: StageRunner; enrich: StageRunner; index: StageRunner };
  onSuccessPing?: () => Promise<void>;
  maxSyncFailures?: number;
  minSuccessRatio?: number;
}

export interface OrchestrateResult { halted: boolean; haltedAt?: 'sync' | 'enrich' | 'index'; reason: string }

export async function orchestrate(opts: OrchestrateOpts): Promise<OrchestrateResult> {
  const { vaultPath, runId, runners } = opts;
  const gates: Record<string, GateVerdict> = {};

  async function writeSummary(result: OrchestrateResult): Promise<void> {
    await writeManifest(vaultPath, runId, {
      stage: 'summary', run_id: runId, started_at: '', finished_at: '',
      ok: !result.halted, exit_code: result.halted ? 1 : 0,
      counts: { processed: 0, succeeded: 0, failed: 0, skipped: 0 }, errors: [],
      extra: {
        halted: result.halted,
        halt_reason: result.halted ? result.reason : null,
        halted_at: result.haltedAt ?? null,
        gates,   // Codex #6: per-stage gate verdicts for the Status API
      },
    });
  }

  // Run one stage: execute the runner, read its manifest, reconcile exit codes (Codex #3),
  // then apply the gate. Returns the manifest (or null with a synthetic failing gate).
  async function runStage(
    name: 'sync' | 'enrich' | 'index',
    gate: (m: StageManifest) => GateVerdict,
  ): Promise<{ passed: boolean; reason: string }> {
    const { exitCode } = await runners[name](runId);
    const m = await readManifest(vaultPath, runId, name);
    if (!m) { const g = { passed: false, reason: `${name} wrote no manifest` }; gates[name] = g; return g; }
    // Codex #3: a disagreement between the runner's exit code and the manifest's recorded
    // exit_code means something is wrong — fail closed rather than trust either alone.
    if (exitCode !== m.exit_code) {
      const g = { passed: false, reason: `${name} exit code ${exitCode} disagrees with manifest exit_code ${m.exit_code}` };
      gates[name] = g; return g;
    }
    const g = gate(m);
    gates[name] = g;
    return g;
  }

  const sync = await runStage('sync', (m) => syncGate(m, opts.maxSyncFailures));
  if (!sync.passed) { const r = { halted: true, haltedAt: 'sync' as const, reason: sync.reason }; await writeSummary(r); return r; }

  const enrich = await runStage('enrich', (m) => enrichGate(m, opts.minSuccessRatio));
  if (!enrich.passed) { const r = { halted: true, haltedAt: 'enrich' as const, reason: enrich.reason }; await writeSummary(r); return r; }

  // Codex #4: index_nonempty comes from the index manifest's extra (written from the real
  // store.stored_hashes() in Task 5), NOT a caller-supplied boolean — no bypass.
  const idx = await runStage('index', (m) => indexGate(m, Boolean((m.extra ?? {}).index_nonempty)));
  if (!idx.passed) { const r = { halted: true, haltedAt: 'index' as const, reason: idx.reason }; await writeSummary(r); return r; }

  const ok = { halted: false, reason: 'all stages passed' };
  await writeSummary(ok);
  if (opts.onSuccessPing) await opts.onSuccessPing();
  return ok;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orchestrate`
Expected: PASS (3 tests — full success, enrich-halt-no-index, sync-halt-no-enrich).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrate.ts test/orchestrate.test.ts
git commit -m "feat(pipeline): orchestrator with chain guard (halts before C on a failed B)"
```

---

### Task 9: Orchestrator entrypoint (real subprocess runners + dead-man ping)

**Files:**
- Create: `src/orchestrate-main.ts` (the executable entry: builds real runners, generates run_id, calls `orchestrate`, sets exit code)
- Modify: `package.json` (add `"orchestrate": "tsx src/orchestrate-main.ts"`)
- Test: `test/orchestrate-main.test.ts` (tests `buildRunId` + `makeHealthcheckPing` only; the spawn wiring is verified by a manual run)

**Interfaces:**
- Consumes: `orchestrate` from `src/orchestrate.js`.
- Produces: `function buildRunId(now: string): string`; `function makeHealthcheckPing(url: string | undefined, fetchFn): () => Promise<void>` (no-op when url undefined; never throws).

**Note:** spawning real subprocesses and opening the live Chroma store are not unit-tested (they need the real environment); they're exercised by the manual run in Step 6 and on the VPS. We unit-test only the pure helpers.

- [ ] **Step 1: Write the failing test**

```typescript
// test/orchestrate-main.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildRunId, makeHealthcheckPing } from '../src/orchestrate-main.js';

describe('buildRunId', () => {
  it('uses an ISO timestamp', () => {
    expect(buildRunId('2026-06-20T03:00:00.000Z')).toBe('2026-06-20T03:00:00.000Z');
  });
});

describe('makeHealthcheckPing', () => {
  it('is a no-op when no url is configured', async () => {
    const fetchFn = vi.fn();
    await makeHealthcheckPing(undefined, fetchFn)();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('pings the url when configured', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }));
    await makeHealthcheckPing('https://hc.example/abc', fetchFn as any)();
    expect(fetchFn).toHaveBeenCalledWith('https://hc.example/abc');
  });
  it('never throws if the ping fails', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network'); });
    await expect(makeHealthcheckPing('https://hc.example/abc', fetchFn as any)()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orchestrate-main`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestrate-main.ts
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { orchestrate, type StageRunner } from './orchestrate.js';

export function buildRunId(nowIso: string): string { return nowIso; }

export function makeHealthcheckPing(url: string | undefined, fetchFn: typeof fetch = fetch): () => Promise<void> {
  return async () => {
    if (!url) return;
    try { await fetchFn(url); } catch { /* dead-man monitor will alert on the MISSING ping; never throw */ }
  };
}

function spawnRunner(cmd: string, args: string[], cwd: string): StageRunner {
  return (runId: string) => new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, RUN_ID: runId } });
    child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
    child.on('error', () => resolve({ exitCode: 1 }));
  });
}

async function main(): Promise<number> {
  const repoRoot = process.cwd();
  const mcpDir = join(repoRoot, 'mcp');
  const runId = buildRunId(new Date().toISOString());
  const ping = makeHealthcheckPing(process.env.HEALTHCHECK_URL);

  // index_nonempty is read by orchestrate() from the index manifest's extra (written by Task 5
  // from the real store.stored_hashes()), so there is no hardcoded bypass here (Codex #4).
  const result = await orchestrate({
    vaultPath: process.env.VAULT_PATH!, runId,
    runners: {
      sync: spawnRunner('npm', ['run', 'sync'], repoRoot),
      enrich: spawnRunner('npm', ['run', 'enrich'], repoRoot),
      index: spawnRunner(join(mcpDir, '.venv', 'bin', 'prd-mcp'), ['index'], mcpDir),
    },
    onSuccessPing: ping,
  });

  if (result.halted) { console.error(`PIPELINE HALTED at ${result.haltedAt}: ${result.reason}`); return 1; }
  console.log('pipeline ok: sync → enrich → index');
  return 0;
}

// Only auto-run as a script, not when imported by tests:
if (process.argv[1] && process.argv[1].endsWith('orchestrate-main.ts')) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
```

Add to `package.json` scripts: `"orchestrate": "tsx src/orchestrate-main.ts"`.

- [ ] **Step 4: Run test + typecheck**

Run: `npm test -- orchestrate-main && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Manual smoke (local, optional but recommended)**

Run (Mac, keychain mode): `VAULT_PATH="/Users/edwardpham/Documents/Backup/Obsidian/ringkas" npm run orchestrate`
Expected: runs sync → enrich → index in order; writes `<vault>/.runs/<run_id>/{sync,enrich,index,summary}.json`; prints `pipeline ok` (or `PIPELINE HALTED at <stage>` with a reason). Verify the manifest files exist.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrate-main.ts package.json test/orchestrate-main.test.ts
git commit -m "feat(pipeline): orchestrator entrypoint (subprocess runners + dead-man ping)"
```

---

## Deploy Runbook (VPS — execute after Phase 2's box is up)

This is operator documentation, not a code task. Captured here so the pipeline migration is reproducible.

1. **Install runtimes** on `openclaw`: Node ≥22 (volta or nvm), Python venv for `mcp/` (`poetry install` or the existing `.venv` pattern).
2. **Vault + index migration:** copy the Mac's vault (`/Users/.../Obsidian/ringkas`) and `.chroma-mcp` to the box; set `VAULT_PATH` to the box path. Run one `prd-mcp index --force` if the index needs rebuilding on the box.
3. **Secrets:** put `NOTION_TOKEN`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `VAULT_PATH`, `STATE_FILE`, plus the Python side's `OPENAI_API_KEY`/`MINIMAX_*`/`CHROMA_PATH` in the chmod-600 `.env`; set `PRD_SECRETS=env`.
4. **systemd timer** runs `npm run orchestrate` daily. Add an `OnFailure=` unit that notifies (ntfy/email). Set `HEALTHCHECK_URL` to a Healthchecks.io check so a MISSED run (timer didn't fire) also alerts.
5. **Cut over:** disable the three Mac launchd jobs (`com.ringkas.prd-sync`, `com.ringkas.prd-enrich`, `com.ringkas.prd-mcp-index`) once the box's first orchestrated run is green.
6. **Verify:** confirm `<vault>/.runs/<run_id>/` has all four manifests and the Status API (Plan A) reads them.

---

## Self-Review

**Spec coverage (against §6 + §8 of the design):**
- Run-manifests per stage → Tasks 1, 3, 4, 5. ✓
- Chain guard halts before C on a failed B → Task 8 (with the 287/287 regression test). ✓
- Counter semantics + no div-zero + no-op-night pass → Task 2 (gate) + Tasks 3–5 (additive counts). ✓
- A-gate single policy → Task 2 `syncGate`. ✓
- Empty-index is a failure (no bypass) → Task 5 (exit_code) + Task 8 (derives index_nonempty from the manifest). ✓
- Exit-code/manifest reconciliation (fail closed) → Task 8 `runStage`. ✓
- `health_gate`/gate verdicts in the manifest contract → Task 1 (`GateVerdict`) + Task 8 (`extra.gates`). ✓
- OnFailure/dead-man alert → Task 9 `makeHealthcheckPing` + the deploy runbook. ✓
- Move pipeline to VPS / Linux secrets for BOTH runtimes → Task 7 (Node A/B) + Task 5b (Python C) + deploy runbook. ✓
- Manifest reader for Status API (halt fields under `extra`) → Task 6 (consumed by Plan A's `status.py`). ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `StageManifest`/`StageCounts`/`GateVerdict` defined in Task 1 and reused verbatim in Tasks 2, 3, 4, 8; the Python manifest in Task 5 mirrors the same JSON field names; `read_latest_run`/`read_run_history` (Task 6) are the exact names Plan A's `status.py` will import; summary halt fields live under `extra` in both the writer (Task 8) and reader (Task 6). ✓

**Codex review iteration 1 (7 findings) — all addressed:** #1 entrypoint guards (Tasks 3, 4) so importing builders is side-effect-free; #2 Python env secret reader (Task 5b); #3 enrich `ok` reflects `errors[]` + exit-code reconciliation (Tasks 4, 8); #4 empty-index failure + manifest-derived `index_nonempty` (Tasks 5, 8, 9); #5 summary halt fields read from `extra` (Task 6); #6 gate verdicts recorded (Tasks 1, 8); #7 additive sync counts (Task 3). ✓

**Cross-plan interface:** Plan A (Status API) imports `read_latest_run`, `read_run_history` from `prd_mcp.web.manifests`. Plan A's `/api/status/pipeline` shape is built from `read_latest_run`'s `{run_id, stages, halted, halt_reason}`.
