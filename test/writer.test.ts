import { expect, test, vi } from 'vitest';
import { writeMarkdown, archiveFile } from '../src/writer.js';
import type { SyncMeta } from '../src/types.js';

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (p: string) => { if (!files.has(p)) { const e: any = new Error('no'); e.code = 'ENOENT'; throw e; } return files.get(p)!; },
    writeFile: async (p: string, d: string) => { files.set(p, d); },
    rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
    mkdir: async () => {},
    unlink: async (p: string) => { if (!files.has(p)) { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } files.delete(p); },
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
  expect(content).toContain('llm:\n  summary: null');
  expect(content).toContain('# Hello');
});

test('re-write preserves hand-edited llm block', async () => {
  const fs = memFs();
  await writeMarkdown({ dir: '/PRDs', stem: 'EP-1-t', sync, body: '# v1\n', fs });
  // Simulate B editing llm:
  const edited = fs.files.get('/PRDs/EP-1-t.md')!.replace('llm:\n  summary: null', 'llm:\n  summary: "B wrote this"');
  fs.files.set('/PRDs/EP-1-t.md', edited);
  // Re-sync with new body:
  await writeMarkdown({ dir: '/PRDs', stem: 'EP-1-t', sync: { ...sync, last_edited: '2026-07-01T00:00:00Z' }, body: '# v2\n', fs });
  const content = fs.files.get('/PRDs/EP-1-t.md')!;
  expect(content).toContain('B wrote this');
  expect(content).toContain('# v2');
  expect(content).not.toContain('# v1');
});

test('I2: existing file with malformed frontmatter is NOT overwritten (fail safe, spec §7)', async () => {
  const fs = memFs();
  const path = '/PRDs/EP-1-t.md';
  // An existing file whose frontmatter cannot be parsed (would lose B's llm if scaffolded over).
  const original = '---\nsync:\n  id: x\n bad: : :\nllm:\n  summary: "B owns this"\n---\n\n# Precious body\n';
  fs.files.set(path, original);

  const errs: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((m: any) => { errs.push(String(m)); });
  try {
    const result = await writeMarkdown({ dir: '/PRDs', stem: 'EP-1-t', sync, body: '# Overwrite attempt\n', fs });
    // Signals the skip:
    expect(result).toBeNull();
  } finally {
    spy.mockRestore();
  }
  // Original bytes are untouched — the file was NOT overwritten.
  expect(fs.files.get(path)).toBe(original);
  expect(fs.files.get(path)).toContain('B owns this');
  expect(fs.files.get(path)).not.toContain('Overwrite attempt');
  // No .tmp left behind:
  expect(fs.files.has(`${path}.tmp`)).toBe(false);
  // A clear warning naming the file was logged to stderr:
  expect(errs.some((e) => e.includes(path))).toBe(true);
});

test('archiveFile moves file (source deleted, archive written with removed_from_notion: true)', async () => {
  const fs = memFs();
  // Seed a file at /PRDs/EP-1-t.md with removed_from_notion: false in frontmatter
  const seedContent = `---\nremoved_from_notion: false\ntitle: T\n---\n# Hello\n`;
  fs.files.set('/PRDs/EP-1-t.md', seedContent);
  await archiveFile({ dir: '/PRDs', filename: 'EP-1-t.md', fs });
  // (a) Source must be deleted — proves MOVE not copy
  expect(fs.files.has('/PRDs/EP-1-t.md')).toBe(false);
  // (b) Archive file must exist
  expect(fs.files.has('/PRDs/_Archive/EP-1-t.md')).toBe(true);
  // (c) Archive content must have removed_from_notion: true
  const archived = fs.files.get('/PRDs/_Archive/EP-1-t.md')!;
  expect(archived).toContain('removed_from_notion: true');
});

test('archiveFile with nonexistent source returns silently without creating archive', async () => {
  const fs = memFs();
  await expect(archiveFile({ dir: '/PRDs', filename: 'does-not-exist.md', fs })).resolves.toBeUndefined();
  expect(fs.files.has('/PRDs/_Archive/does-not-exist.md')).toBe(false);
});
