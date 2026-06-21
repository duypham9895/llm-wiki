import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface StageCounts { processed: number; succeeded: number; failed: number; skipped: number }

export interface GateVerdict { passed: boolean; reason: string }

export interface StageManifest {
  stage: 'sync' | 'enrich' | 'index' | 'summary';
  run_id: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  exit_code: number;
  counts: StageCounts;
  errors: string[];
  health_gate?: GateVerdict;       // spec §6 manifest contract; set by the orchestrator
  extra?: Record<string, unknown>;
}

function runDir(vaultPath: string, runId: string): string {
  return join(vaultPath, '.runs', runId);
}

export async function writeManifest(vaultPath: string, runId: string, m: StageManifest): Promise<string> {
  const dir = runDir(vaultPath, runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${m.stage}.json`);
  await writeFile(path, JSON.stringify(m, null, 2), 'utf8');
  return path;
}

export async function readManifest(vaultPath: string, runId: string, stage: string): Promise<StageManifest | null> {
  try {
    const raw = await readFile(join(runDir(vaultPath, runId), `${stage}.json`), 'utf8');
    return JSON.parse(raw) as StageManifest;
  } catch {
    return null;
  }
}
