import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { buildSyncBlock, parseExisting, composeFile, DEFAULT_LLM_BLOCK } from '../src/frontmatter.js';
import type { SyncMeta } from '../src/types.js';

// Parse the frontmatter region of a composed file back into a JS object.
// Uses the same closing-fence rule as parseExisting (a line that is exactly "---").
function parseFrontmatter(file: string): any {
  expect(file.startsWith('---\n')).toBe(true);
  const m = /\n---(?:\n|$)/g;
  m.lastIndex = 4;
  const hit = m.exec(file);
  expect(hit).not.toBeNull();
  const fm = file.slice(4, hit!.index + 1);
  return parse(fm);
}

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

test('parseExisting extracts llm block and composeFile preserves its VALUES across a re-sync', () => {
  // Structured extraction is value-preserving (not byte-for-byte): flow collections may be
  // re-serialized to block form, but re-parsing must yield identical data.
  const customLlm = 'llm:\n  summary: "Hand-written by B"\n  tags: [auth, tenancy]\n  related: ["[[EP-1-x]]"]\n';
  const original = composeFile(sync, customLlm, '# Old body\n');
  const { llmRaw } = parseExisting(original);
  expect(llmRaw).not.toBeNull();
  // Re-sync with new sync data + new body, but llm must survive unchanged in meaning:
  const next = { ...sync, last_edited: '2026-07-01T00:00:00Z' };
  const rewritten = composeFile(next, llmRaw, '# New body\n');
  const round = parseExisting(rewritten).llmRaw;
  // Round-trip is stable: extracting again yields the same text.
  expect(round).toBe(llmRaw);
  // And the VALUES are exactly what B wrote.
  const parsed = parseFrontmatter(rewritten);
  expect(parsed.llm).toEqual({
    summary: 'Hand-written by B',
    tags: ['auth', 'tenancy'],
    related: ['[[EP-1-x]]'],
  });
  expect(rewritten).toContain('# New body');
  expect(rewritten).toContain('Hand-written by B');
});

test('parseExisting returns null when no llm block', () => {
  expect(parseExisting('---\nsync:\n  id: x\n---\nbody').llmRaw).toBeNull();
});

test('parseExisting is not fooled by a sync field value containing a newline + ---', () => {
  // The closing fence is a line that is EXACTLY "---". A "\n---" sequence that is part of a
  // YAML scalar value (i.e. "---" followed by non-newline characters on the same line) must
  // NOT be mistaken for the fence. The old code used indexOf('\n---', 4) which matched ANY
  // "\n---" including "--- text in a value", truncating the frontmatter early and dropping
  // the trailing llm block. The fix uses /\n---(?:\n|$)/g which only matches a bare "---" line.
  const customLlm = 'llm:\n  summary: "B owns this"\n  tags: [x]\n  related: []\n';
  // A sync field VALUE that contains "\n---..." inside valid YAML (a quoted scalar), placed
  // BEFORE the llm block. Old code stops at the fake fence; new code reaches the real one.
  const dangerousFile =
    '---\n' +
    'sync:\n' +
    '  id: EP-827\n' +
    "  note: '--- not a fence, just text in a value'\n" + // \n--- followed by non-\n
    customLlm +
    '---\n' +
    '\n# Body\n';
  // Confirm the dangerous sequence is genuinely present:
  expect(dangerousFile).toContain("\n  note: '---");
  // The parser must reach the REAL fence and extract the llm block (value-preserving).
  const { llmRaw, parseError } = parseExisting(dangerousFile);
  expect(parseError).toBeUndefined();
  expect(llmRaw).not.toBeNull();
  expect(parse(llmRaw!).llm).toEqual({ summary: 'B owns this', tags: ['x'], related: [] });
});

// C1 regression: llm: BEFORE sync: must NOT corrupt the file on rewrite.
// The old slice-to-end-of-frontmatter logic captured the trailing sync block, producing
// duplicate sync keys -> yaml.parse "Map keys must be unique" -> unreadable file.
test('C1: llm-before-sync round-trips to valid single-sync YAML with llm intact', () => {
  // A hand-edited / B-reserialized file where llm precedes sync (key order NOT guaranteed):
  const file =
    '---\n' +
    'llm:\n' +
    '  summary: "B\'s enrichment"\n' +
    '  tags: [auth]\n' +
    '  related: []\n' +
    'sync:\n' +
    '  id: EP-OLD\n' +
    '  status: Old\n' +
    '---\n' +
    '\n# Old body\n';

  const { llmRaw, parseError } = parseExisting(file);
  expect(parseError).toBeUndefined();
  expect(llmRaw).not.toBeNull();

  // Re-sync with NEW sync data + NEW body:
  const next: SyncMeta = { ...sync, id: 'EP-NEW', status: 'NewStatus' };
  const rewritten = composeFile(next, llmRaw, '# New body\n');

  // (a) Result is VALID YAML with exactly ONE sync key and ONE llm key.
  const parsed = parseFrontmatter(rewritten); // throws if duplicate/invalid keys
  expect(Object.keys(parsed).sort()).toEqual(['llm', 'sync']);
  // Canonical order: sync block emitted FIRST, llm SECOND.
  const syncFenceIdx = rewritten.indexOf('\nsync:');
  const llmFenceIdx = rewritten.indexOf('\nllm:');
  expect(syncFenceIdx).toBeGreaterThan(-1);
  expect(llmFenceIdx).toBeGreaterThan(syncFenceIdx);
  // No duplicate sync key leaked from the captured trailing block:
  expect(rewritten.match(/^sync:/gm)?.length).toBe(1);

  // (b) llm values are unchanged.
  expect(parsed.llm).toEqual({ summary: "B's enrichment", tags: ['auth'], related: [] });

  // (c) New sync status + new body are present.
  expect(parsed.sync.status).toBe('NewStatus');
  expect(rewritten).toContain('# New body');
  expect(rewritten).not.toContain('# Old body');
});

// B may add keys we did not anticipate under llm — they must survive the round-trip.
test('C1: llm with extra/unknown keys survives the round-trip', () => {
  const file =
    '---\n' +
    'sync:\n' +
    '  id: EP-1\n' +
    'llm:\n' +
    '  summary: "enriched"\n' +
    '  tags: [a, b]\n' +
    '  related: ["[[EP-2-x]]"]\n' +
    '  embedding_model: text-3\n' +   // unanticipated extra key
    '  confidence: 0.91\n' +
    '---\n' +
    '\n# Body\n';

  const { llmRaw } = parseExisting(file);
  expect(llmRaw).not.toBeNull();
  const rewritten = composeFile({ ...sync, status: 'X' }, llmRaw, '# B2\n');
  const parsed = parseFrontmatter(rewritten);
  expect(parsed.llm).toEqual({
    summary: 'enriched',
    tags: ['a', 'b'],
    related: ['[[EP-2-x]]'],
    embedding_model: 'text-3',
    confidence: 0.91,
  });
});

// Spec §7: frontmatter that exists but cannot be parsed must signal a parseError so the
// writer can fail safe (never scaffold over it).
test('parseExisting signals parseError on existing-but-malformed frontmatter', () => {
  const malformed = '---\nsync:\n  id: x\n bad: : :\nllm: oops: :\n---\n\n# Body\n';
  const r = parseExisting(malformed);
  expect(r.parseError).toBe(true);
  expect(r.llmRaw).toBeNull();
});
