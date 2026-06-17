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

test('parseExisting is not fooled by a sync field value containing a newline + ---', () => {
  // yaml.stringify encodes "\n---\n" via block scalar indentation (indents --- as "    ---"),
  // so composeFile itself never emits the dangerous bytes via short_summary. The real risk
  // is files modified by external editors where "---" appears at the start of a line inside
  // the frontmatter but is followed by non-newline characters (i.e. NOT a real fence line).
  // The old code used indexOf('\n---', 4) which matched ANY \n--- including "---more text",
  // truncating the frontmatter early and losing the llm block.
  // The fix uses /\n---(?:\n|$)/g which only matches a line that is exactly "---".
  const customLlm = 'llm:\n  summary: "B owns this"\n  tags: [x]\n  related: []\n';
  // Construct a file where "---more text" appears as a line in the frontmatter
  // BEFORE the llm block. This is the dangerous byte sequence (\n--- followed by non-\n)
  // that old code mistakes for the closing fence.
  const dangerousFile =
    '---\n' +
    'sync:\n' +
    '  id: EP-827\n' +
    '---more text\n' +  // \n--- followed by 'm' — not a real fence, but old code stops here
    customLlm +
    '---\n' +
    '\n# Body\n';
  // Confirm the dangerous sequence is genuinely present:
  expect(dangerousFile).toContain('\n---more');
  expect(parseExisting(dangerousFile).llmRaw).toBe(customLlm);
});
