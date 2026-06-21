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
