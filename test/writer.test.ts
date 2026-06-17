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
  const edited = fs.files.get('/PRDs/EP-1-t.md')!.replace('llm:\n  summary: null', 'llm:\n  summary: "B wrote this"');
  fs.files.set('/PRDs/EP-1-t.md', edited);
  // Re-sync with new body:
  await writeMarkdown({ dir: '/PRDs', stem: 'EP-1-t', sync: { ...sync, last_edited: '2026-07-01T00:00:00Z' }, body: '# v2\n', fs });
  const content = fs.files.get('/PRDs/EP-1-t.md')!;
  expect(content).toContain('B wrote this');
  expect(content).toContain('# v2');
  expect(content).not.toContain('# v1');
});
