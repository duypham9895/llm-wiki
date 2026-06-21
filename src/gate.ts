import type { StageManifest } from './manifest.js';

export interface GateResult { passed: boolean; reason: string }

export function syncGate(m: StageManifest, maxSyncFailures = 0): GateResult {
  if (m.exit_code !== 0) return { passed: false, reason: `sync exited ${m.exit_code}` };
  if (m.counts.failed > maxSyncFailures)
    return { passed: false, reason: `sync failed ${m.counts.failed} > max ${maxSyncFailures}` };
  return { passed: true, reason: 'sync ok' };
}

export function enrichGate(m: StageManifest, minSuccessRatio = 0.5): GateResult {
  if (m.exit_code !== 0) return { passed: false, reason: `enrich exited ${m.exit_code}` };
  const { processed, succeeded, failed } = m.counts;
  if (processed === 0) return { passed: true, reason: 'enrich no-op (nothing to enrich)' };
  if (failed === 0) return { passed: true, reason: 'enrich ok (no failures)' };
  const ratio = succeeded / processed;
  if (ratio >= minSuccessRatio) return { passed: true, reason: `enrich ok (${succeeded}/${processed})` };
  return { passed: false, reason: `enrich ${succeeded}/${processed} (ratio ${ratio.toFixed(2)} < ${minSuccessRatio})` };
}

export function indexGate(m: StageManifest, indexNonEmpty: boolean): GateResult {
  if (m.exit_code !== 0) return { passed: false, reason: `index exited ${m.exit_code}` };
  if (!indexNonEmpty) return { passed: false, reason: 'index is empty after run' };
  return { passed: true, reason: 'index ok' };
}
