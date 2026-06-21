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
