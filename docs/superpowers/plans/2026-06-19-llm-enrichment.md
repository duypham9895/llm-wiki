# LLM Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/TypeScript CLI (`npm run enrich`) that reads sub-project A's synced PRD Markdown and fills each file's reserved `llm:` frontmatter block with an LLM summary, normalized tags, and ranked "related" backlinks — incrementally, resumably, chained after A's nightly sync.

**Architecture:** A two-phase pipeline reusing A's hardened frontmatter merge. Phase 1 (per-doc, independent): distill a large body to a bounded view, call the LLM for `{summary, tags}`, write `llm.summary`/`llm.tags`. Phase 2 (cross-doc, after all tags exist): for each doc compute top-K candidates by tag/metadata overlap, LLM-judge each candidate from summaries, write symmetric `llm.related[]`. The LLM lives behind one swappable OpenAI-compatible `llm-client` module. Bookkeeping (`enriched_at`, `body_hash`) lives inside the `llm:` block A already preserves.

**Tech Stack:** Node 22 (ESM), TypeScript, Vitest, `yaml` (already a dep), `node:crypto` (sha256), the host's `fetch` (OpenAI-compatible HTTP). macOS `security` CLI for the API key. Reuses A's `composeFile`/`parseExisting` (frontmatter), `withDeadline` (timeout).

## Global Constraints

- **Stack:** Node ≥22, TypeScript, ESM (`"type":"module"`). Test runner Vitest. Tests live in `test/**/*.test.ts` (existing glob — no vitest config change). B source lives under `src/enrich/` (covered by tsconfig `"src"` include — no tsconfig change).
- **LLM auth:** API key read at runtime from the macOS keychain via `security find-generic-password -s ringkas-prd-enrich -a llm-api-key -w`. Never from a git-tracked file; never logged. (Mirrors A's `readKeychainToken`.)
- **LLM endpoint:** OpenAI-compatible `POST {baseUrl}/chat/completions` with `Authorization: Bearer <key>`, body `{ model, messages, response_format?, temperature }`. Base URL + model come from config/env. **To confirm at smoke-run time:** exact base URL, model string, OpenAI-compatibility. The endpoint shape is isolated entirely in `src/enrich/llm-client.ts`.
- **The `llm:` write must never disturb `sync:` or the body.** B reuses A's `composeFile(sync, llmRaw, body)`: it parses the existing file, keeps the existing `sync` object and body verbatim, and passes a freshly-built `llm` block. Atomic temp-file + rename.
- **Never overwrite good enrichment with a failure.** An LLM/parse/timeout failure for a doc leaves that doc's existing `llm:` untouched and counts as an error; the run continues (one bad doc never aborts the run).
- **Incremental by content hash.** Re-enrich a doc only if `llm.summary` is null OR `sha256(currentBody) !== llm.body_hash`. Hash the body B actually enriched from, not A's `last_edited`.
- **Related is symmetric and self-excluding.** If D relates to C then C relates to D (deduped); a doc never relates to itself.
- **Tag normalization is load-bearing.** Lowercase, kebab-case, trim, dedupe — Phase 2 candidate recall depends on it.
- **Vault layout:** PRD files are `<vaultPath>/PRDs/*.md` (excluding the `_attachments/` and `_Archive/` subdirs and files prefixed `_`).

---

## File Structure

All paths relative to `llm-wiki/`. B adds files under `src/enrich/` and `test/`; it modifies only `package.json` (one script) and reuses A's modules unchanged.

| File | Responsibility |
|---|---|
| `package.json` | Add `"enrich": "tsx src/enrich/enrich-index.ts"` script |
| `src/enrich/enrich-types.ts` | Shared interfaces (`Summary`, `Verdict`, `DocRecord`, `EnrichConfig`) |
| `src/enrich/enrich-config.ts` | Load + validate settings; read keychain API key |
| `src/enrich/llm-client.ts` | The swappable OpenAI-compatible client: `chatJSON(messages, opts)` → validated JSON. Retry/backoff/timeout. |
| `src/enrich/distill.ts` | `distill(frontmatterFields, body, opts)` → bounded prompt view |
| `src/enrich/tags.ts` | `normalizeTag` / `normalizeTags` (pure) |
| `src/enrich/summarize.ts` | `summarizeDoc(distilled, llm)` → `{summary, tags}` (prompt + parse + normalize) |
| `src/enrich/overlap.ts` | `overlapScore` + `topKCandidates` (pure candidate math) |
| `src/enrich/relate.ts` | `judgeRelated(a, b, llm)` + `buildRelated(docs, K, judge)` → symmetric related map |
| `src/enrich/doc-io.ts` | Read a PRD file → `{ sync, llmObj, body, bodyHash }`; write a new `llm` block via `composeFile` (atomic). Owns vault file discovery. |
| `src/enrich/enrich-index.ts` | Orchestrator: Phase 1 then Phase 2, run summary, exit code |
| `test/enrich/*.test.ts` | Unit tests + fixtures |

---

## Task 1: Scaffold — script, shared types

**Files:**
- Modify: `package.json`
- Create: `src/enrich/enrich-types.ts`, `test/enrich/smoke.test.ts`

**Interfaces:**
- Produces: `Summary`, `Verdict`, `DocRecord`, `EnrichConfig`, `LlmFields`.

- [ ] **Step 1: Add the enrich script to `package.json`**

In the `"scripts"` block, add the `enrich` line (keep the others):
```json
  "scripts": {
    "sync": "tsx src/index.ts",
    "enrich": "tsx src/enrich/enrich-index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
```

- [ ] **Step 2: Create `src/enrich/enrich-types.ts`**

```ts
// The llm: block B owns (A preserves it value-for-value across re-syncs).
export interface LlmFields {
  summary: string | null;
  tags: string[];
  related: string[];      // ["[[EP-...-slug]]", ...]
  enriched_at?: string;   // ISO-8601, B bookkeeping
  body_hash?: string;     // sha256 of the body B enriched from
}

// What summarize produces (validated LLM output, pre-normalization for tags).
export interface Summary {
  summary: string;
  tags: string[];
}

// What the LLM judge returns for a candidate pair.
export interface Verdict {
  related: boolean;
  reason: string;
}

// One PRD file loaded into memory for enrichment.
export interface DocRecord {
  path: string;           // absolute path to the .md
  stem: string;           // filename without .md, used to build the wikilink
  syncRaw: unknown;       // the parsed `sync` object (kept verbatim on write)
  llm: LlmFields;         // current llm block (may be empty)
  body: string;           // markdown body after frontmatter
  bodyHash: string;       // sha256(body)
  // frontmatter fields the distiller/overlap need, lifted from syncRaw:
  title: string;
  shortSummary: string | null;
  status: string | null;
  platform: string[];
  strategicGoal: string[];
}

export interface EnrichConfig {
  apiKey: string;
  baseUrl: string;        // e.g. https://api.minimax.io/v1
  model: string;          // e.g. MiniMax-M2 (confirm exact string)
  vaultPath: string;
  topK: number;           // related candidates per doc (default 5)
  distillThreshold: number; // bytes; bodies larger than this get distilled (default 8000)
  sectionHeadChars: number; // chars kept under each heading when distilling (default 200)
  llmTimeoutMs: number;   // per-call wall-clock (default 60000)
  maxRetries: number;     // default 3
}
```

- [ ] **Step 3: Create `test/enrich/smoke.test.ts`**

```ts
import { expect, test } from 'vitest';
import type { EnrichConfig } from '../../src/enrich/enrich-types.js';

test('enrich types load', () => {
  const c: Partial<EnrichConfig> = { topK: 5, model: 'MiniMax-M2' };
  expect(c.topK).toBe(5);
});
```

- [ ] **Step 4: Run**

Run: `npm test`
Expected: existing suite still green + this new test passes.

- [ ] **Step 5: Commit**

```bash
git add package.json src/enrich/enrich-types.ts test/enrich/smoke.test.ts
git commit -m "chore: scaffold enrich subproject with shared types and script"
```

---

## Task 2: Config + keychain API key

**Files:**
- Create: `src/enrich/enrich-config.ts`, `test/enrich/enrich-config.test.ts`

**Interfaces:**
- Consumes: `EnrichConfig` from `enrich-types.ts`.
- Produces:
  - `readEnrichKey(): string` — runs the `security` CLI.
  - `loadEnrichConfig(env: NodeJS.ProcessEnv, readKey: () => string): EnrichConfig` — pure given its injected key reader.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { loadEnrichConfig } from '../../src/enrich/enrich-config.js';

const env = { VAULT_PATH: '/tmp/v', LLM_BASE_URL: 'https://api.x/v1', LLM_MODEL: 'MiniMax-M2' } as unknown as NodeJS.ProcessEnv;

test('loads config with injected key and defaults', () => {
  const c = loadEnrichConfig(env, () => 'sk-key');
  expect(c.apiKey).toBe('sk-key');
  expect(c.baseUrl).toBe('https://api.x/v1');
  expect(c.model).toBe('MiniMax-M2');
  expect(c.vaultPath).toBe('/tmp/v');
  expect(c.topK).toBe(5);
  expect(c.distillThreshold).toBe(8000);
  expect(c.llmTimeoutMs).toBe(60000);
});

test('throws when vault path missing', () => {
  expect(() => loadEnrichConfig({} as NodeJS.ProcessEnv, () => 'k')).toThrow(/VAULT_PATH/);
});
test('throws when base url missing', () => {
  expect(() => loadEnrichConfig({ VAULT_PATH: '/tmp/v' } as unknown as NodeJS.ProcessEnv, () => 'k')).toThrow(/LLM_BASE_URL/);
});
test('throws when key empty', () => {
  expect(() => loadEnrichConfig(env, () => '')).toThrow(/key/i);
});
test('env overrides for topK and threshold parse to numbers', () => {
  const c = loadEnrichConfig({ ...env, TOP_K: '8', DISTILL_THRESHOLD: '12000' } as unknown as NodeJS.ProcessEnv, () => 'k');
  expect(c.topK).toBe(8);
  expect(c.distillThreshold).toBe(12000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrich/enrich-config.test.ts`
Expected: FAIL — cannot find `../../src/enrich/enrich-config.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { execFileSync } from 'node:child_process';
import type { EnrichConfig } from './enrich-types.js';

export function readEnrichKey(): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-s', 'ringkas-prd-enrich', '-a', 'llm-api-key', '-w'],
    { encoding: 'utf8' },
  ).trim();
}

export function loadEnrichConfig(env: NodeJS.ProcessEnv, readKey: () => string): EnrichConfig {
  const vaultPath = env.VAULT_PATH;
  if (!vaultPath) throw new Error('VAULT_PATH env var is required');
  const baseUrl = env.LLM_BASE_URL;
  if (!baseUrl) throw new Error('LLM_BASE_URL env var is required');
  const model = env.LLM_MODEL ?? 'MiniMax-M2';
  const apiKey = readKey();
  if (!apiKey) throw new Error('LLM API key is empty (keychain read failed)');
  return {
    apiKey, baseUrl, model, vaultPath,
    topK: env.TOP_K ? Number(env.TOP_K) : 5,
    distillThreshold: env.DISTILL_THRESHOLD ? Number(env.DISTILL_THRESHOLD) : 8000,
    sectionHeadChars: env.SECTION_HEAD_CHARS ? Number(env.SECTION_HEAD_CHARS) : 200,
    llmTimeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : 60000,
    maxRetries: env.LLM_MAX_RETRIES ? Number(env.LLM_MAX_RETRIES) : 3,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrich/enrich-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/enrich/enrich-config.ts test/enrich/enrich-config.test.ts
git commit -m "feat: enrich config loader with keychain api key"
```

---

## Task 3: Tag normalization

**Files:**
- Create: `src/enrich/tags.ts`, `test/enrich/tags.test.ts`

**Interfaces:**
- Produces:
  - `normalizeTag(raw: string): string`
  - `normalizeTags(raw: string[]): string[]` — normalize, drop empties, dedupe, preserve first-seen order.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { normalizeTag, normalizeTags } from '../../src/enrich/tags.js';

test('normalizeTag lowercases and kebab-cases', () => {
  expect(normalizeTag('Saudi CRM')).toBe('saudi-crm');
  expect(normalizeTag('  Email_Notifications ')).toBe('email-notifications');
  expect(normalizeTag('AI/Agent')).toBe('ai-agent');
});
test('normalizeTags dedupes case-insensitively and drops empties, preserving order', () => {
  expect(normalizeTags(['CRM', 'crm', 'Saudi', '', '  ', 'saudi'])).toEqual(['crm', 'saudi']);
});
test('normalizeTags strips leading/trailing hyphens from punctuation', () => {
  expect(normalizeTags(['(beta)', '#tag'])).toEqual(['beta', 'tag']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrich/tags.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const n = normalizeTag(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrich/tags.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/enrich/tags.ts test/enrich/tags.test.ts
git commit -m "feat: deterministic tag normalization"
```

---

## Task 4: Distill — bounded prompt view for large docs

**Files:**
- Create: `src/enrich/distill.ts`, `test/enrich/distill.test.ts`

**Interfaces:**
- Produces:
  - `distill(args: { title: string; shortSummary: string | null; status: string | null; platform: string[]; strategicGoal: string[]; body: string; threshold: number; sectionHeadChars: number }): string` — if `body.length <= threshold`, returns a header block + the whole body; otherwise a header block + every heading line with the first `sectionHeadChars` chars of text beneath it.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { distill } from '../../src/enrich/distill.js';

const base = { title: 'PRD X', shortSummary: 'short', status: 'In Development', platform: ['AI Agent'], strategicGoal: ['RISA-NXT'], threshold: 100, sectionHeadChars: 30 };

test('small body passes through whole, with a header block', () => {
  const out = distill({ ...base, threshold: 10000, body: '## Goal\nShip it.\n' });
  expect(out).toContain('Title: PRD X');
  expect(out).toContain('Status: In Development');
  expect(out).toContain('## Goal');
  expect(out).toContain('Ship it.');
});

test('large body is distilled to headings + bounded section heads', () => {
  const big = '## Background\n' + 'x'.repeat(500) + '\n## Goal\n' + 'y'.repeat(500) + '\n';
  const out = distill({ ...base, threshold: 100, sectionHeadChars: 20, body: big });
  expect(out).toContain('## Background');
  expect(out).toContain('## Goal');
  // each section's text is truncated to ~20 chars, so the full 500-char runs are NOT present
  expect(out).not.toContain('x'.repeat(100));
  expect(out).not.toContain('y'.repeat(100));
  expect(out.length).toBeLessThan(big.length);
});

test('large body with no headings still returns the header block and a bounded excerpt', () => {
  const big = 'z'.repeat(500);
  const out = distill({ ...base, threshold: 100, sectionHeadChars: 20, body: big });
  expect(out).toContain('Title: PRD X');
  expect(out.length).toBeLessThan(big.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrich/distill.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
export function distill(args: {
  title: string; shortSummary: string | null; status: string | null;
  platform: string[]; strategicGoal: string[]; body: string;
  threshold: number; sectionHeadChars: number;
}): string {
  const header =
    `Title: ${args.title}\n` +
    `Short summary: ${args.shortSummary ?? '(none)'}\n` +
    `Status: ${args.status ?? '(none)'}\n` +
    `Platform: ${args.platform.join(', ') || '(none)'}\n` +
    `Strategic goal: ${args.strategicGoal.join(', ') || '(none)'}\n\n`;

  if (args.body.length <= args.threshold) {
    return header + args.body;
  }

  const lines = args.body.split('\n');
  const out: string[] = [];
  let underHeading = 0; // chars emitted since the last heading
  let sawHeading = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      out.push(line);
      underHeading = 0;
      sawHeading = true;
    } else if (underHeading < args.sectionHeadChars && line.trim()) {
      const remaining = args.sectionHeadChars - underHeading;
      out.push(line.slice(0, remaining));
      underHeading += Math.min(line.length, remaining);
    }
  }
  // No headings at all: fall back to a single bounded excerpt of the body.
  const distilledBody = sawHeading ? out.join('\n') : args.body.slice(0, args.sectionHeadChars * 5);
  return header + distilledBody;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrich/distill.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/enrich/distill.ts test/enrich/distill.test.ts
git commit -m "feat: distill large doc bodies to a bounded prompt view"
```

---

## Task 5: LLM client (OpenAI-compatible, retry/timeout, schema-validated JSON)

**Files:**
- Create: `src/enrich/llm-client.ts`, `test/enrich/llm-client.test.ts`

**Interfaces:**
- Consumes: `withDeadline` from `../timeout.js` (A's helper).
- Produces:
  - `interface LlmClient { chatJSON<T>(messages: ChatMessage[], opts: { validate: (v: unknown) => v is T; label: string }): Promise<T>; }`
  - `type ChatMessage = { role: 'system' | 'user'; content: string }`
  - `makeLlmClient(cfg: { apiKey: string; baseUrl: string; model: string; llmTimeoutMs: number; maxRetries: number; fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void> }): LlmClient` — POSTs to `{baseUrl}/chat/completions`, parses `choices[0].message.content` as JSON, runs `validate`; retries on HTTP 429/5xx and on JSON-invalid/validation-fail (re-asking once for valid JSON), bounded by `maxRetries`; each attempt wrapped in `withDeadline`.

Only the retry/validate/parse logic is unit-tested with an injected `fetchFn`. No live endpoint in CI.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { makeLlmClient } from '../../src/enrich/llm-client.js';

type Out = { summary: string };
const isOut = (v: unknown): v is Out =>
  typeof v === 'object' && v !== null && typeof (v as any).summary === 'string';

function fetchReturning(bodies: string[]): typeof fetch {
  let i = 0;
  return (async () => {
    const content = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;
}

test('parses valid JSON content and validates', async () => {
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 2, fetchFn: fetchReturning(['{"summary":"ok"}']), sleepFn: async () => {} });
  const r = await c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' });
  expect(r.summary).toBe('ok');
});

test('retries once on invalid JSON then succeeds', async () => {
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 3, fetchFn: fetchReturning(['not json', '{"summary":"recovered"}']), sleepFn: async () => {} });
  const r = await c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' });
  expect(r.summary).toBe('recovered');
});

test('throws after exhausting retries on persistently invalid output', async () => {
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 2, fetchFn: fetchReturning(['nope']), sleepFn: async () => {} });
  await expect(c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' })).rejects.toThrow();
});

test('retries on HTTP 500 then succeeds', async () => {
  let i = 0;
  const fetchFn = (async () => {
    i++;
    if (i < 2) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"summary":"ok"}' } }] }) };
  }) as unknown as typeof fetch;
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 3, fetchFn, sleepFn: async () => {} });
  const r = await c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' });
  expect(r.summary).toBe('ok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrich/llm-client.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
import { withDeadline } from '../timeout.js';

export type ChatMessage = { role: 'system' | 'user'; content: string };

export interface LlmClient {
  chatJSON<T>(messages: ChatMessage[], opts: { validate: (v: unknown) => v is T; label: string }): Promise<T>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Extract the first JSON object from a model response (tolerates ```json fences / prose).
function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object in response');
  return JSON.parse(candidate.slice(start, end + 1));
}

export function makeLlmClient(cfg: {
  apiKey: string; baseUrl: string; model: string; llmTimeoutMs: number; maxRetries: number;
  fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void>;
}): LlmClient {
  const fetchFn = cfg.fetchFn ?? fetch;
  const sleepFn = cfg.sleepFn ?? defaultSleep;

  async function callOnce(messages: ChatMessage[]): Promise<unknown> {
    const res = (await withDeadline(
      fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2 }),
      }),
      cfg.llmTimeoutMs,
      'llm chat',
    )) as Response;
    if (!res.ok) {
      const e: any = new Error(`llm http ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const data: any = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    return extractJson(content);
  }

  return {
    async chatJSON<T>(messages: ChatMessage[], opts: { validate: (v: unknown) => v is T; label: string }): Promise<T> {
      let attempt = 0;
      let msgs = messages;
      for (;;) {
        try {
          const parsed = await callOnce(msgs);
          if (opts.validate(parsed)) return parsed;
          throw new Error(`validation failed: ${opts.label}`);
        } catch (err: any) {
          const status = err?.status;
          const httpRetriable = status === 429 || (typeof status === 'number' && status >= 500);
          const contentRetriable = !status; // parse/validate failure
          if (attempt >= cfg.maxRetries || (!httpRetriable && !contentRetriable)) throw err;
          if (contentRetriable) {
            msgs = [...messages, { role: 'user', content: 'Your previous reply was not valid JSON matching the requested schema. Reply with ONLY the JSON object.' }];
          }
          await sleepFn(Math.min(2 ** attempt * 300, 5000));
          attempt++;
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrich/llm-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/enrich/llm-client.ts test/enrich/llm-client.test.ts
git commit -m "feat: openai-compatible llm client with retry, timeout, json validation"
```

---

## Task 6: Summarize — distilled view → {summary, tags}

**Files:**
- Create: `src/enrich/summarize.ts`, `test/enrich/summarize.test.ts`

**Interfaces:**
- Consumes: `LlmClient`/`ChatMessage` from `llm-client.ts`; `normalizeTags` from `tags.ts`; `Summary` from `enrich-types.ts`.
- Produces: `summarizeDoc(distilled: string, llm: LlmClient): Promise<Summary>` — builds the prompt, calls `llm.chatJSON` with a `Summary` validator, returns `{ summary, tags: normalizeTags(...) }`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { summarizeDoc } from '../../src/enrich/summarize.js';
import type { LlmClient } from '../../src/enrich/llm-client.js';

function fakeLlm(reply: unknown): LlmClient {
  return { chatJSON: (async (_m: any, opts: any) => { if (!opts.validate(reply)) throw new Error('bad'); return reply; }) as any };
}

test('returns summary and normalized tags', async () => {
  const llm = fakeLlm({ summary: 'It does X.', tags: ['Saudi CRM', 'crm', 'Email'] });
  const out = await summarizeDoc('Title: PRD X\n...', llm);
  expect(out.summary).toBe('It does X.');
  expect(out.tags).toEqual(['saudi-crm', 'crm', 'email']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrich/summarize.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { LlmClient, ChatMessage } from './llm-client.js';
import type { Summary } from './enrich-types.js';
import { normalizeTags } from './tags.js';

const isSummary = (v: unknown): v is Summary =>
  typeof v === 'object' && v !== null &&
  typeof (v as any).summary === 'string' &&
  Array.isArray((v as any).tags) && (v as any).tags.every((t: unknown) => typeof t === 'string');

export async function summarizeDoc(distilled: string, llm: LlmClient): Promise<Summary> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You summarize product requirement documents. Reply with ONLY a JSON object {"summary": string, "tags": string[]}. The summary is one paragraph: what the PRD delivers, for whom, and its current status. Tags are 3-8 short topic/product/area keywords.' },
    { role: 'user', content: distilled },
  ];
  const raw = await llm.chatJSON<Summary>(messages, { validate: isSummary, label: 'summary' });
  return { summary: raw.summary.trim(), tags: normalizeTags(raw.tags) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrich/summarize.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/enrich/summarize.ts test/enrich/summarize.test.ts
git commit -m "feat: summarize a distilled doc into summary + normalized tags"
```

---

## Task 7: Overlap — candidate scoring + top-K

**Files:**
- Create: `src/enrich/overlap.ts`, `test/enrich/overlap.test.ts`

**Interfaces:**
- Produces:
  - `overlapScore(a, b): number` where each arg is `{ tags: string[]; platform: string[]; strategicGoal: string[] }` — `2×|shared tags| + |shared platform| + |shared strategicGoal|`.
  - `topKCandidates<T extends { stem: string; tags: string[]; platform: string[]; strategicGoal: string[] }>(doc: T, all: T[], k: number): T[]` — the k highest-scoring OTHER docs with score > 0, sorted by score desc then stem asc (stable, self-excluded).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { overlapScore, topKCandidates } from '../../src/enrich/overlap.js';

const d = (stem: string, tags: string[], platform: string[] = [], strategicGoal: string[] = []) => ({ stem, tags, platform, strategicGoal });

test('overlapScore weights tags double', () => {
  expect(overlapScore(d('a', ['x', 'y'], ['P']), d('b', ['x'], ['P']))).toBe(2 * 1 + 1); // 1 shared tag*2 + 1 shared platform
});

test('topK excludes self, drops zero-overlap, ranks by score then stem', () => {
  const a = d('a', ['x', 'y'], ['P']);
  const b = d('b', ['x', 'y'], ['P']);   // score 5
  const c = d('c', ['x'], []);            // score 2
  const z = d('z', ['q'], []);            // score 0 -> dropped
  const out = topKCandidates(a, [a, b, c, z], 5).map((o) => o.stem);
  expect(out).toEqual(['b', 'c']);
});

test('topK respects k', () => {
  const a = d('a', ['x']);
  const b = d('b', ['x']);
  const c = d('c', ['x']);
  const out = topKCandidates(a, [a, b, c], 1).map((o) => o.stem);
  expect(out).toEqual(['b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrich/overlap.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
function sharedCount(a: string[], b: string[]): number {
  const set = new Set(a);
  let n = 0;
  for (const x of b) if (set.has(x)) n++;
  return n;
}

export function overlapScore(
  a: { tags: string[]; platform: string[]; strategicGoal: string[] },
  b: { tags: string[]; platform: string[]; strategicGoal: string[] },
): number {
  return 2 * sharedCount(a.tags, b.tags) + sharedCount(a.platform, b.platform) + sharedCount(a.strategicGoal, b.strategicGoal);
}

export function topKCandidates<T extends { stem: string; tags: string[]; platform: string[]; strategicGoal: string[] }>(
  doc: T, all: T[], k: number,
): T[] {
  return all
    .filter((o) => o.stem !== doc.stem)
    .map((o) => ({ o, s: overlapScore(doc, o) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => (y.s - x.s) || x.o.stem.localeCompare(y.o.stem))
    .slice(0, k)
    .map((x) => x.o);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrich/overlap.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/enrich/overlap.ts test/enrich/overlap.test.ts
git commit -m "feat: candidate overlap scoring and top-K selection"
```

---

## Task 8: Relate — LLM-judge candidates into a symmetric related map

**Files:**
- Create: `src/enrich/relate.ts`, `test/enrich/relate.test.ts`

**Interfaces:**
- Consumes: `LlmClient` from `llm-client.ts`; `Verdict` from `enrich-types.ts`; `topKCandidates` from `overlap.ts`.
- Produces:
  - `type RelateDoc = { stem: string; summary: string; tags: string[]; platform: string[]; strategicGoal: string[] }`
  - `judgeRelated(a: RelateDoc, b: RelateDoc, llm: LlmClient): Promise<boolean>` — LLM verdict from the two summaries.
  - `buildRelated(docs: RelateDoc[], k: number, judge: (a: RelateDoc, b: RelateDoc) => Promise<boolean>): Promise<Map<string, string[]>>` — for each doc, judge its top-K candidates; record confirmed links SYMMETRICALLY (both stems), deduped; returns stem → ranked `["[[stem]]", ...]`. A judge that throws for a pair is treated as not-related (skip).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { buildRelated, type RelateDoc } from '../../src/enrich/relate.js';

const d = (stem: string, tags: string[]): RelateDoc => ({ stem, summary: stem, tags, platform: [], strategicGoal: [] });

test('confirmed links are symmetric and wikilinked', async () => {
  const a = d('a', ['x']); const b = d('b', ['x']); const c = d('c', ['q']);
  // judge: a-b related, anything with c not related
  const judge = async (x: RelateDoc, y: RelateDoc) => [x.stem, y.stem].every((s) => s !== 'c');
  const map = await buildRelated([a, b, c], 5, judge);
  expect(map.get('a')).toEqual(['[[b]]']);
  expect(map.get('b')).toEqual(['[[a]]']);   // symmetric
  expect(map.get('c') ?? []).toEqual([]);
});

test('a throwing judge is treated as not-related (no crash)', async () => {
  const a = d('a', ['x']); const b = d('b', ['x']);
  const judge = async () => { throw new Error('llm down'); };
  const map = await buildRelated([a, b], 5, judge);
  expect(map.get('a') ?? []).toEqual([]);
  expect(map.get('b') ?? []).toEqual([]);
});

test('no duplicate links when both directions judged true', async () => {
  const a = d('a', ['x']); const b = d('b', ['x']);
  const judge = async () => true;
  const map = await buildRelated([a, b], 5, judge);
  expect(map.get('a')).toEqual(['[[b]]']);
  expect(map.get('b')).toEqual(['[[a]]']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrich/relate.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { LlmClient, ChatMessage } from './llm-client.js';
import type { Verdict } from './enrich-types.js';
import { topKCandidates } from './overlap.js';

export type RelateDoc = { stem: string; summary: string; tags: string[]; platform: string[]; strategicGoal: string[] };

const isVerdict = (v: unknown): v is Verdict =>
  typeof v === 'object' && v !== null && typeof (v as any).related === 'boolean';

export async function judgeRelated(a: RelateDoc, b: RelateDoc, llm: LlmClient): Promise<boolean> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You decide whether two product requirement documents are directly related (shared feature area, dependency, or subsystem). Reply with ONLY {"related": boolean, "reason": string}.' },
    { role: 'user', content: `Doc A: ${a.summary}\n\nDoc B: ${b.summary}` },
  ];
  const v = await llm.chatJSON<Verdict>(messages, { validate: isVerdict, label: 'verdict' });
  return v.related;
}

export async function buildRelated(
  docs: RelateDoc[], k: number, judge: (a: RelateDoc, b: RelateDoc) => Promise<boolean>,
): Promise<Map<string, string[]>> {
  // ordered set of related stems per doc, preserving candidate (overlap) order
  const links = new Map<string, string[]>();
  for (const d of docs) links.set(d.stem, []);
  const add = (from: string, to: string) => {
    const arr = links.get(from)!;
    if (!arr.includes(`[[${to}]]`)) arr.push(`[[${to}]]`);
  };

  for (const doc of docs) {
    const candidates = topKCandidates(doc, docs, k);
    for (const cand of candidates) {
      let related = false;
      try {
        related = await judge(doc, cand);
      } catch {
        related = false; // a failed judge is "not related", never aborts the pass
      }
      if (related) {
        add(doc.stem, cand.stem);
        add(cand.stem, doc.stem); // symmetric
      }
    }
  }
  return links;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrich/relate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/enrich/relate.ts test/enrich/relate.test.ts
git commit -m "feat: llm-judged symmetric related-link builder over top-K candidates"
```

---

## Task 9: Doc I/O — read a PRD, write the llm block (reusing A's composeFile)

**Files:**
- Create: `src/enrich/doc-io.ts`, `test/enrich/doc-io.test.ts`

**Interfaces:**
- Consumes: `parseExisting`, `composeFile` from `../frontmatter.js`; `DocRecord`, `LlmFields` from `enrich-types.ts`. Uses `node:crypto`, `node:fs/promises`, `yaml`.
- Produces:
  - `hashBody(body: string): string` — sha256 hex.
  - `splitFrontmatter(content: string): { sync: unknown; llm: LlmFields; body: string }` — parse the file's frontmatter into the sync object + llm fields + body (the inverse view A writes).
  - `buildLlmRaw(llm: LlmFields): string` — single-key `llm:` YAML text (ends with newline), matching what `composeFile` expects.
  - `writeLlmBlock(opts: { path: string; sync: unknown; body: string; llm: LlmFields; fs?: FsLikeMin }): Promise<void>` — atomic temp+rename, rebuilding the file with `composeFile(sync as SyncMeta, buildLlmRaw(llm), body)`. If the on-disk file's frontmatter has `parseError`, do NOT write (fail safe); throw a typed error the caller records.
  - `listPrdFiles(prdsDir: string): Promise<string[]>` — `.md` files directly under `PRDs/`, excluding names starting with `_`.
  - `FsLikeMin` — `{ readFile, writeFile, rename }` injectable for tests.

Note: `composeFile` takes the parsed `sync` as its first arg and re-serializes it; passing the `sync` object we parsed out round-trips `sync:` value-for-value (same value-preserving guarantee A documents). The body is preserved byte-for-byte.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { hashBody, splitFrontmatter, buildLlmRaw, writeLlmBlock } from '../../src/enrich/doc-io.js';

const fileWith = (llmLines: string) =>
`---
sync:
  id: EP-1
  uuid: u
  title: "T"
  status: In Development
${''}llm:
${llmLines}---

# Body line
more body
`;

test('splitFrontmatter pulls sync, llm, and body', () => {
  const content = fileWith('  summary: null\n  tags: []\n  related: []\n');
  const { sync, llm, body } = splitFrontmatter(content);
  expect((sync as any).id).toBe('EP-1');
  expect(llm.summary).toBeNull();
  expect(body).toContain('# Body line');
});

test('hashBody is stable and content-sensitive', () => {
  expect(hashBody('a')).toBe(hashBody('a'));
  expect(hashBody('a')).not.toBe(hashBody('b'));
});

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (p: string) => { if (!files.has(p)) { const e: any = new Error('no'); e.code = 'ENOENT'; throw e; } return files.get(p)!; },
    writeFile: async (p: string, d: string) => { files.set(p, d); },
    rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
  };
}

test('writeLlmBlock replaces only the llm block; sync and body survive', async () => {
  const fs = memFs();
  const original = fileWith('  summary: null\n  tags: []\n  related: []\n');
  fs.files.set('/v/PRDs/EP-1.md', original);
  const { sync, body } = splitFrontmatter(original);
  await writeLlmBlock({ path: '/v/PRDs/EP-1.md', sync, body, llm: { summary: 'done', tags: ['saudi'], related: ['[[EP-2]]'], enriched_at: '2026-06-19T00:00:00Z', body_hash: 'abc' }, fs });
  const out = fs.files.get('/v/PRDs/EP-1.md')!;
  expect(out).toContain('summary: done');
  expect(out).toContain('saudi');
  expect(out).toContain('[[EP-2]]');
  expect(out).toContain('id: EP-1');       // sync survived
  expect(out).toContain('# Body line');    // body survived
  expect(out).toContain('more body');
});

test('writeLlmBlock fails safe on unparseable frontmatter (does not overwrite)', async () => {
  const fs = memFs();
  const broken = '---\nsync:\n  id: EP-1\n   bad-indent: x\nllm:\n  summary: null\n---\nbody\n';
  fs.files.set('/v/PRDs/EP-1.md', broken);
  await expect(writeLlmBlock({ path: '/v/PRDs/EP-1.md', sync: {}, body: 'body', llm: { summary: 'x', tags: [], related: [] }, fs })).rejects.toThrow();
  expect(fs.files.get('/v/PRDs/EP-1.md')).toBe(broken); // untouched
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enrich/doc-io.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseExisting, composeFile } from '../frontmatter.js';
import type { SyncMeta } from '../types.js';
import type { LlmFields } from './enrich-types.js';

export interface FsLikeMin {
  readFile: (p: string, enc?: any) => Promise<string>;
  writeFile: (p: string, d: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
}
const defaultFs: FsLikeMin = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  writeFile: (p, d) => nodeFs.writeFile(p, d, 'utf8'),
  rename: (a, b) => nodeFs.rename(a, b),
};

export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function splitFrontmatter(content: string): { sync: unknown; llm: LlmFields; body: string } {
  if (!content.startsWith('---\n')) throw new Error('no frontmatter');
  const fenceRe = /\n---(?:\n|$)/g;
  fenceRe.lastIndex = 4;
  const m = fenceRe.exec(content);
  if (!m) throw new Error('no closing fence');
  const fm = content.slice(4, m.index + 1);
  const body = content.slice(m.index + 1).replace(/^---\n?/, '').replace(/^\n/, '');
  const data = parse(fm) as Record<string, unknown>;
  const llmObj = (data?.llm ?? {}) as Record<string, unknown>;
  const llm: LlmFields = {
    summary: (llmObj.summary as string | null) ?? null,
    tags: Array.isArray(llmObj.tags) ? (llmObj.tags as string[]) : [],
    related: Array.isArray(llmObj.related) ? (llmObj.related as string[]) : [],
    enriched_at: llmObj.enriched_at as string | undefined,
    body_hash: llmObj.body_hash as string | undefined,
  };
  return { sync: data?.sync, llm, body };
}

export function buildLlmRaw(llm: LlmFields): string {
  // omit undefined bookkeeping keys for cleanliness
  const obj: Record<string, unknown> = { summary: llm.summary, tags: llm.tags, related: llm.related };
  if (llm.enriched_at) obj.enriched_at = llm.enriched_at;
  if (llm.body_hash) obj.body_hash = llm.body_hash;
  return stringify({ llm: obj }, { lineWidth: 0 });
}

export async function writeLlmBlock(opts: {
  path: string; sync: unknown; body: string; llm: LlmFields; fs?: FsLikeMin;
}): Promise<void> {
  const fs = opts.fs ?? defaultFs;
  // fail safe: if the on-disk file can't be parsed, do not overwrite it
  const existing = await fs.readFile(opts.path);
  const probe = parseExisting(existing);
  if (probe.parseError) throw new Error(`refusing to overwrite unparseable frontmatter: ${opts.path}`);
  const content = composeFile(opts.sync as SyncMeta, buildLlmRaw(opts.llm), opts.body);
  const tmp = `${opts.path}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, opts.path);
}

export async function listPrdFiles(prdsDir: string): Promise<string[]> {
  const entries = await readdir(prdsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
    .map((e) => join(prdsDir, e.name))
    .sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enrich/doc-io.test.ts`
Expected: PASS (4 tests). The "fails safe" and "sync+body survive" tests are the critical ones.

- [ ] **Step 5: Commit**

```bash
git add src/enrich/doc-io.ts test/enrich/doc-io.test.ts
git commit -m "feat: doc-io — read PRD, write llm block via composeFile with fail-safe"
```

---

## Task 10: Orchestrator — two-phase pipeline, summary, exit code

**Files:**
- Create: `src/enrich/enrich-index.ts`
- Modify: none

**Interfaces:**
- Consumes: every prior enrich module + A's nothing-new. No new exported types.

This wires tested units; verification is `npm run typecheck` + the Task 11 smoke run.

- [ ] **Step 1: Write `src/enrich/enrich-index.ts`**

```ts
import { join } from 'node:path';
import { loadEnrichConfig, readEnrichKey } from './enrich-config.js';
import { makeLlmClient } from './llm-client.js';
import { distill } from './distill.js';
import { summarizeDoc } from './summarize.js';
import { buildRelated, judgeRelated, type RelateDoc } from './relate.js';
import { listPrdFiles, splitFrontmatter, hashBody, writeLlmBlock } from './doc-io.js';
import type { DocRecord, LlmFields } from './enrich-types.js';
import { readFile } from 'node:fs/promises';

function liftFields(sync: any): { title: string; shortSummary: string | null; status: string | null; platform: string[]; strategicGoal: string[] } {
  return {
    title: sync?.title ?? '(untitled)',
    shortSummary: sync?.short_summary ?? null,
    status: sync?.status ?? null,
    platform: Array.isArray(sync?.platform) ? sync.platform : [],
    strategicGoal: Array.isArray(sync?.strategic_goal) ? sync.strategic_goal : [],
  };
}

async function main(): Promise<number> {
  const cfg = loadEnrichConfig(process.env, readEnrichKey);
  const llm = makeLlmClient(cfg);
  const prdsDir = join(cfg.vaultPath, 'PRDs');

  const paths = await listPrdFiles(prdsDir);
  const docs: DocRecord[] = [];
  const errors: string[] = [];

  // Load all docs
  for (const path of paths) {
    try {
      const content = await readFile(path, 'utf8');
      const { sync, llm: llmFields, body } = splitFrontmatter(content);
      const f = liftFields(sync);
      docs.push({
        path, stem: path.split('/').pop()!.replace(/\.md$/, ''),
        syncRaw: sync, llm: llmFields, body, bodyHash: hashBody(body), ...f,
      });
    } catch (err) {
      errors.push(`load ${path}: ${(err as Error).message}`);
    }
  }

  // Phase 1: summarize docs that are new or whose body changed
  let enriched = 0, skipped = 0;
  for (const doc of docs) {
    const needs = doc.llm.summary === null || doc.llm.body_hash !== doc.bodyHash;
    if (!needs) { skipped++; continue; }
    try {
      const distilled = distill({ ...doc, threshold: cfg.distillThreshold, sectionHeadChars: cfg.sectionHeadChars });
      const s = await summarizeDoc(distilled, llm);
      doc.llm = { ...doc.llm, summary: s.summary, tags: s.tags, enriched_at: new Date().toISOString(), body_hash: doc.bodyHash };
      enriched++;
    } catch (err) {
      errors.push(`summarize ${doc.stem}: ${(err as Error).message}`);
    }
  }

  // Phase 2: related over docs that have tags (skip ones with no summary yet)
  const relatable: RelateDoc[] = docs
    .filter((d) => d.llm.summary !== null)
    .map((d) => ({ stem: d.stem, summary: d.llm.summary!, tags: d.llm.tags, platform: d.platform, strategicGoal: d.strategicGoal }));
  const relatedMap = await buildRelated(relatable, cfg.topK, (a, b) => judgeRelated(a, b, llm));
  let relatedPairs = 0;
  for (const doc of docs) {
    const rel = relatedMap.get(doc.stem);
    if (rel) { doc.llm.related = rel; relatedPairs += rel.length; }
  }

  // Write back every doc whose llm changed (enriched this run OR related changed)
  for (const doc of docs) {
    try {
      await writeLlmBlock({ path: doc.path, sync: doc.syncRaw, body: doc.body, llm: doc.llm });
    } catch (err) {
      errors.push(`write ${doc.stem}: ${(err as Error).message}`);
    }
  }

  console.log(`enriched ${enriched} · skipped ${skipped} · related-links ${relatedPairs} · errors ${errors.length}`);
  if (errors.length) { console.error('Errors:\n' + errors.map((e) => '  - ' + e).join('\n')); return 1; }
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. Fix any signature mismatches against the Interfaces blocks above.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: all enrich + existing A tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/enrich/enrich-index.ts
git commit -m "feat: enrich orchestrator — two-phase summarize then relate"
```

---

## Task 11: Chained schedule, README, live smoke run

**Files:**
- Create: `launchd/com.ringkas.prd-enrich.plist`
- Modify: `README.md` (add an Enrichment section)

**Interfaces:** none (operational).

- [ ] **Step 1: Create `launchd/com.ringkas.prd-enrich.plist`**

Runs at 04:23 daily (after A's 03:17 sync). Replace `<USER>`, `<VAULT_PATH>`, `<LLM_BASE_URL>` before loading.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ringkas.prd-enrich</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd /Users/&lt;USER&gt;/Documents/Workspace/Ringkas/Programming/Personal/llm-wiki &amp;&amp; VAULT_PATH="&lt;VAULT_PATH&gt;" LLM_BASE_URL="&lt;LLM_BASE_URL&gt;" LLM_MODEL="MiniMax-M2" /opt/homebrew/bin/npm run enrich</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>23</integer></dict>
  <key>StandardOutPath</key><string>/tmp/prd-enrich.log</string>
  <key>StandardErrorPath</key><string>/tmp/prd-enrich.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Add an Enrichment section to `README.md`**

Append:
```markdown

## Enrichment (sub-project B)

After A syncs, B fills each PRD's `llm:` frontmatter block with an LLM summary,
tags, and related-PRD backlinks.

### Setup (once)
Store the LLM API key: `security add-generic-password -s ringkas-prd-enrich -a llm-api-key -w '<KEY>'`

### Run
```bash
VAULT_PATH="/path/to/Vault" LLM_BASE_URL="https://your-endpoint/v1" LLM_MODEL="MiniMax-M2" npm run enrich
```

### Schedule
`launchd/com.ringkas.prd-enrich.plist` runs at 04:23 (after A's 03:17 sync). Edit the placeholders, then:
```bash
cp launchd/com.ringkas.prd-enrich.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ringkas.prd-enrich.plist
```

B only writes the `llm:` block; A's `sync:` block and body are never touched.
```

- [ ] **Step 3: Live smoke run into a throwaway vault copy**

Run:
```bash
rm -rf /tmp/enrich-vault && cp -R /tmp/smoke-vault /tmp/enrich-vault
VAULT_PATH="/tmp/enrich-vault" LLM_BASE_URL="<your-base-url>" LLM_MODEL="<your-model>" npm run enrich
```
Expected: prints `enriched N · skipped M · related-links J · errors E`. Exit 0 (or non-zero only if some docs errored — inspect them).

- [ ] **Step 4: Verify a known doc was enriched correctly**

Run:
```bash
sed -n '/^llm:/,/^---/p' /tmp/enrich-vault/PRDs/EP-838-*.md
```
Expected: `summary:` is a real paragraph (not null), `tags:` are normalized kebab-case, `related:` has ≥0 `[[EP-...]]` wikilinks, plus `enriched_at` and `body_hash`. Confirm `sync:` and the body above/below are unchanged from the synced original (diff against `/tmp/smoke-vault`).

- [ ] **Step 5: Verify idempotency (incremental)**

Run the same enrich command again:
```bash
VAULT_PATH="/tmp/enrich-vault" LLM_BASE_URL="<your-base-url>" LLM_MODEL="<your-model>" npm run enrich
```
Expected: `enriched 0 · skipped N · …` — nothing re-summarized (body_hash unchanged).

- [ ] **Step 6: Commit**

```bash
git add launchd/com.ringkas.prd-enrich.plist README.md
git commit -m "chore: enrich launchd schedule, README, verified smoke run"
```

---

## Self-Review

**Spec coverage (spec § → task):**
- §1 B consumes A's contract → doc-io reuses `composeFile`/`parseExisting` (Task 9). ✓
- §2 scope summary+tags+related → Tasks 6, 8. ✓
- §2 LLM provider (custom OpenAI-compatible, keychain) → Tasks 2, 5. ✓
- §2 large-doc head+structure → Task 4. ✓
- §2 re-enrich on empty-or-changed (body_hash) → Tasks 9 (hash) + 10 (logic). ✓
- §2 related = LLM-judge top-K, symmetric → Tasks 7 + 8. ✓
- §2 chained schedule → Task 11. ✓
- §4 llm: block + bookkeeping fields → Tasks 1 (types) + 9 (buildLlmRaw). ✓
- §4 tag normalization load-bearing → Task 3, used in Task 6. ✓
- §4 two-phase (tags before relate) → Task 10. ✓
- §5 incremental + resumable → Task 10 (skip unchanged; re-run picks up null/changed). ✓
- §6 error handling (one bad doc never aborts; never overwrite good llm with failure; fail-safe parse) → Tasks 8, 9, 10. ✓
- §7 testing (mock llm, fixtures, smoke) → Tasks 4-9 unit, Task 11 smoke. ✓
- §9 one-time setup (keychain key) → Task 2 + README (Task 11). ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. The smoke-run base URL/model are intentionally `<your-…>` placeholders the user fills with their confirmed endpoint (the one open item from the spec). ✓

**Type consistency:** `LlmFields`/`Summary`/`Verdict`/`DocRecord`/`EnrichConfig` defined in Task 1, used consistently. `LlmClient.chatJSON` signature matches between Tasks 5, 6, 8. `RelateDoc` matches Tasks 8, 10. `splitFrontmatter`/`writeLlmBlock`/`buildLlmRaw` signatures match Tasks 9, 10. `topKCandidates` shape matches Tasks 7, 8. `distill` arg shape matches Tasks 4, 10. ✓

**Known follow-ups (intentionally deferred, not gaps):** Phase-2 currently rebuilds related over ALL summarized docs each run (not just changed neighborhoods) — correct but does up to N×K judge calls every run. The incremental Phase-2 optimization (only re-judge neighborhoods of changed docs) is a noted refinement; flag for the implementer to confirm acceptable cost at smoke-run time, mirroring how A's runtime was tuned against real data. Also: MOC/index pages and embedding-based relatedness are out of scope per spec §8.
