/**
 * Cross-plan contract emitter (A↔B integration retest).
 *
 * Uses the REAL Plan-B manifest machinery (writeManifest + the orchestrator's
 * summary shape) to write manifests into a vault's .runs/<run_id>/ directory.
 * A Python test (mcp/tests/web/test_crossplan_manifest.py) then reads them via
 * Plan-A's read_latest_run/read_run_history and asserts the contract holds
 * end-to-end, across the TS→Python language boundary.
 *
 * Usage: tsx test/crossplan-emit.ts <vaultDir> <scenario>
 *   scenario = "healthy"  → sync+enrich+index all ok + a summary(halted:false)
 *   scenario = "halted"   → sync ok, enrich FAILED, NO index, summary(halted:true at enrich)
 *
 * Writes run_ids that are real ISO timestamps so Python's lexical newest-first
 * sort behaves as in production. Emits two runs (an older one + the scenario run)
 * so read_run_history ordering is exercised too.
 */
import { writeManifest, type StageManifest } from '../src/manifest.js';

function stage(
  s: StageManifest['stage'],
  runId: string,
  ok: boolean,
  counts: Partial<StageManifest['counts']>,
  extra?: Record<string, unknown>,
): StageManifest {
  return {
    stage: s,
    run_id: runId,
    started_at: `${runId}`,
    finished_at: `${runId}`,
    ok,
    exit_code: ok ? 0 : 1,
    counts: { processed: 0, succeeded: 0, failed: 0, skipped: 0, ...counts },
    errors: [],
    ...(extra ? { extra } : {}),
  };
}

async function main(): Promise<number> {
  const vault = process.argv[2];
  const scenario = process.argv[3] ?? 'healthy';
  if (!vault) {
    console.error('usage: tsx test/crossplan-emit.ts <vaultDir> <healthy|halted>');
    return 2;
  }

  // An older run, always fully healthy — exercises read_run_history ordering.
  const olderRun = '2026-06-20T03:00:00.000Z';
  await writeManifest(vault, olderRun, stage('sync', olderRun, true, { processed: 3, succeeded: 3 }));
  await writeManifest(vault, olderRun, stage('enrich', olderRun, true, { processed: 2, succeeded: 2 }));
  await writeManifest(vault, olderRun, stage('index', olderRun, true, { processed: 2, succeeded: 2 }, { index_nonempty: true }));
  await writeManifest(vault, olderRun, {
    stage: 'summary', run_id: olderRun, started_at: '', finished_at: '', ok: true, exit_code: 0,
    counts: { processed: 0, succeeded: 0, failed: 0, skipped: 0 }, errors: [],
    extra: { halted: false, halt_reason: null, halted_at: null, gates: { sync: { passed: true, reason: 'sync ok' } } },
  });

  // The newer "scenario" run.
  const newRun = '2026-06-21T03:00:00.000Z';
  if (scenario === 'healthy') {
    await writeManifest(vault, newRun, stage('sync', newRun, true, { processed: 5, succeeded: 5 }));
    await writeManifest(vault, newRun, stage('enrich', newRun, true, { processed: 5, succeeded: 5 }));
    await writeManifest(vault, newRun, stage('index', newRun, true, { processed: 5, succeeded: 5 }, { index_nonempty: true }));
    await writeManifest(vault, newRun, {
      stage: 'summary', run_id: newRun, started_at: '', finished_at: '', ok: true, exit_code: 0,
      counts: { processed: 0, succeeded: 0, failed: 0, skipped: 0 }, errors: [],
      extra: { halted: false, halt_reason: null, halted_at: null,
               gates: { sync: { passed: true, reason: 'sync ok' }, enrich: { passed: true, reason: 'enrich ok' }, index: { passed: true, reason: 'index ok' } } },
    });
  } else {
    // The 287/287 incident shape: enrich fails its gate, index never runs, summary halts at enrich.
    await writeManifest(vault, newRun, stage('sync', newRun, true, { processed: 0, skipped: 287 }));
    await writeManifest(vault, newRun, stage('enrich', newRun, false, { processed: 287, succeeded: 0, failed: 287 }));
    // NO index manifest (chain halted before it).
    await writeManifest(vault, newRun, {
      stage: 'summary', run_id: newRun, started_at: '', finished_at: '', ok: false, exit_code: 1,
      counts: { processed: 0, succeeded: 0, failed: 0, skipped: 0 }, errors: [],
      extra: { halted: true, halt_reason: 'enrich 0/287 (ratio 0.00 < 0.5)', halted_at: 'enrich',
               gates: { sync: { passed: true, reason: 'sync ok' }, enrich: { passed: false, reason: 'enrich 0/287 (ratio 0.00 < 0.5)' } } },
    });
  }

  // Print the run ids so the Python side can assert exact expectations.
  console.log(JSON.stringify({ olderRun, newRun, scenario }));
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
