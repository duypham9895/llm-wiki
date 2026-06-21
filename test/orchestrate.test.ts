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
