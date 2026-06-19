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

test('buildLlmRaw includes enriched_at/body_hash when present, omits when undefined', () => {
  const withFields = buildLlmRaw({ summary: 's', tags: ['a'], related: [], enriched_at: '2026-06-19T00:00:00Z', body_hash: 'abc' });
  expect(withFields).toContain('enriched_at:');
  expect(withFields).toContain('body_hash: abc');
  const without = buildLlmRaw({ summary: 's', tags: ['a'], related: [] });
  expect(without).not.toContain('enriched_at:');
  expect(without).not.toContain('body_hash:');
});

// Fix 3: sync guard tests
test('writeLlmBlock throws and does NOT write when sync is undefined', async () => {
  const fs = memFs();
  fs.files.set('/v/PRDs/EP-1.md', fileWith('  summary: null\n  tags: []\n  related: []\n'));
  const writeCount = { n: 0 };
  const trackingFs = {
    ...fs,
    writeFile: async (p: string, d: string) => { writeCount.n++; await fs.writeFile(p, d); },
  };
  await expect(
    writeLlmBlock({ path: '/v/PRDs/EP-1.md', sync: undefined, body: 'body', llm: { summary: 'x', tags: [], related: [] }, fs: trackingFs })
  ).rejects.toThrow(/refusing to write: missing\/invalid sync block/);
  expect(writeCount.n).toBe(0);
});

test('writeLlmBlock throws and does NOT write when sync is null', async () => {
  const fs = memFs();
  fs.files.set('/v/PRDs/EP-1.md', fileWith('  summary: null\n  tags: []\n  related: []\n'));
  const writeCount = { n: 0 };
  const trackingFs = {
    ...fs,
    writeFile: async (p: string, d: string) => { writeCount.n++; await fs.writeFile(p, d); },
  };
  await expect(
    writeLlmBlock({ path: '/v/PRDs/EP-1.md', sync: null, body: 'body', llm: { summary: 'x', tags: [], related: [] }, fs: trackingFs })
  ).rejects.toThrow(/refusing to write: missing\/invalid sync block/);
  expect(writeCount.n).toBe(0);
});

// Fix 4: unknown llm keys survive round-trip
test('splitFrontmatter preserves unknown llm keys in extra', () => {
  const content = fileWith('  summary: hi\n  tags: []\n  related: []\n  confidence: 0.9\n  embedding_model: text-x\n');
  const { llm } = splitFrontmatter(content);
  expect(llm.extra).toBeDefined();
  expect(llm.extra!['confidence']).toBe(0.9);
  expect(llm.extra!['embedding_model']).toBe('text-x');
});

test('buildLlmRaw carries unknown llm keys through', () => {
  const raw = buildLlmRaw({ summary: 's', tags: [], related: [], extra: { confidence: 0.9, embedding_model: 'text-x' } });
  expect(raw).toContain('confidence: 0.9');
  expect(raw).toContain('embedding_model: text-x');
});

test('writeLlmBlock round-trip preserves unknown llm keys', async () => {
  const fs = memFs();
  const original = fileWith('  summary: null\n  tags: []\n  related: []\n  confidence: 0.9\n');
  fs.files.set('/v/PRDs/EP-1.md', original);
  const { sync, llm, body } = splitFrontmatter(original);
  // Extra key should be in llm.extra after split
  expect(llm.extra?.['confidence']).toBe(0.9);
  await writeLlmBlock({ path: '/v/PRDs/EP-1.md', sync, body, llm, fs });
  const out = fs.files.get('/v/PRDs/EP-1.md')!;
  expect(out).toContain('confidence: 0.9'); // unknown key survived
});

test('splitFrontmatter sets no extra field when llm has only known keys', () => {
  const content = fileWith('  summary: hi\n  tags: []\n  related: []\n');
  const { llm } = splitFrontmatter(content);
  expect(llm.extra).toBeUndefined();
});
