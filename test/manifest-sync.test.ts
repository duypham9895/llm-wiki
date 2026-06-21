import { describe, it, expect } from 'vitest';
import { buildSyncManifest } from '../src/index.js';

describe('buildSyncManifest', () => {
  it('maps a healthy run with additive counts', () => {
    const m = buildSyncManifest('r1', 'a', 'b', { synced: 3, skipped: 280, archived: 1, errors: [] });
    expect(m.stage).toBe('sync');
    expect(m.counts).toEqual({ processed: 4, succeeded: 4, failed: 0, skipped: 280 });
    expect(m.ok).toBe(true);
    expect(m.exit_code).toBe(0);
    expect(m.extra?.archived).toBe(1);
  });

  it('flags failure and keeps counts additive when there are errors', () => {
    const m = buildSyncManifest('r1', 'a', 'b', { synced: 2, skipped: 1, archived: 1, errors: ['boom'] });
    expect(m.counts).toEqual({ processed: 4, succeeded: 3, failed: 1, skipped: 1 }); // 2 synced + 1 archived + 1 error
    expect(m.ok).toBe(false);
    expect(m.exit_code).toBe(1);
  });
});
