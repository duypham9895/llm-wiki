import { describe, it, expect } from 'vitest';
import { syncGate, enrichGate, indexGate } from '../src/gate.js';
import type { StageManifest } from '../src/manifest.js';

function m(stage: StageManifest['stage'], exit: number, c: Partial<StageManifest['counts']>): StageManifest {
  return {
    stage, run_id: 'r', started_at: 'a', finished_at: 'b', ok: exit === 0, exit_code: exit,
    counts: { processed: 0, succeeded: 0, failed: 0, skipped: 0, ...c }, errors: [],
  };
}

describe('syncGate', () => {
  it('passes on exit 0 with no failures', () => expect(syncGate(m('sync', 0, { processed: 3, succeeded: 3 })).passed).toBe(true));
  it('fails on nonzero exit', () => expect(syncGate(m('sync', 1, {})).passed).toBe(false));
  it('fails when failures exceed the threshold', () => expect(syncGate(m('sync', 0, { failed: 1 })).passed).toBe(false));
  it('tolerates failures up to maxSyncFailures', () => expect(syncGate(m('sync', 0, { failed: 2 }), 2).passed).toBe(true));
});

describe('enrichGate (the 287/287 incident)', () => {
  it('FAILS the 0/287 case', () => expect(enrichGate(m('enrich', 0, { processed: 287, succeeded: 0, failed: 287 })).passed).toBe(false));
  it('PASSES a no-op night (processed=0) with no division by zero', () => {
    const r = enrichGate(m('enrich', 0, { processed: 0, skipped: 287 }));
    expect(r.passed).toBe(true);
    expect(r.reason).not.toContain('NaN');
  });
  it('PASSES when ratio >= 0.5', () => expect(enrichGate(m('enrich', 0, { processed: 10, succeeded: 6, failed: 4 })).passed).toBe(true));
  it('FAILS when ratio < 0.5', () => expect(enrichGate(m('enrich', 0, { processed: 10, succeeded: 4, failed: 6 })).passed).toBe(false));
  it('fails on nonzero exit regardless of counts', () => expect(enrichGate(m('enrich', 1, { processed: 10, succeeded: 10 })).passed).toBe(false));
});

describe('indexGate', () => {
  it('passes on exit 0 and non-empty index', () => expect(indexGate(m('index', 0, { processed: 5 }), true).passed).toBe(true));
  it('fails on empty index', () => expect(indexGate(m('index', 0, { processed: 5 }), false).passed).toBe(false));
  it('fails on nonzero exit', () => expect(indexGate(m('index', 1, {}), true).passed).toBe(false));
});
