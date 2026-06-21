// src/orchestrate-main.ts
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { orchestrate, type StageRunner } from './orchestrate.js';

export function buildRunId(nowIso: string): string { return nowIso; }

export function makeHealthcheckPing(url: string | undefined, fetchFn: typeof fetch = fetch): () => Promise<void> {
  return async () => {
    if (!url) return;
    try { await fetchFn(url); } catch { /* dead-man monitor will alert on the MISSING ping; never throw */ }
  };
}

function spawnRunner(cmd: string, args: string[], cwd: string): StageRunner {
  return (runId: string) => new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, RUN_ID: runId } });
    child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
    child.on('error', () => resolve({ exitCode: 1 }));
  });
}

async function main(): Promise<number> {
  const repoRoot = process.cwd();
  const mcpDir = join(repoRoot, 'mcp');
  const runId = buildRunId(new Date().toISOString());
  const ping = makeHealthcheckPing(process.env.HEALTHCHECK_URL);

  // index_nonempty is read by orchestrate() from the index manifest's extra (written by Task 5
  // from the real store.stored_hashes()), so there is no hardcoded bypass here (Codex #4).
  const result = await orchestrate({
    vaultPath: process.env.VAULT_PATH!, runId,
    runners: {
      sync: spawnRunner('npm', ['run', 'sync'], repoRoot),
      enrich: spawnRunner('npm', ['run', 'enrich'], repoRoot),
      index: spawnRunner(join(mcpDir, '.venv', 'bin', 'prd-mcp'), ['index'], mcpDir),
    },
    onSuccessPing: ping,
  });

  if (result.halted) { console.error(`PIPELINE HALTED at ${result.haltedAt}: ${result.reason}`); return 1; }
  console.log('pipeline ok: sync → enrich → index');
  return 0;
}

// Only auto-run as a script, not when imported by tests:
if (process.argv[1] && process.argv[1].endsWith('orchestrate-main.ts')) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
