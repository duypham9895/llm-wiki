import { describe, it, expect } from 'vitest';
import { buildEnrichManifest } from '../../src/enrich/enrich-index.js';

describe('buildEnrichManifest', () => {
  it('maps a healthy incremental run', () => {
    const m = buildEnrichManifest('r1', 'a', 'b', { enriched: 5, skipped: 282, failed: 0, errors: [], relatedPairs: 12, written: 5 });
    expect(m.stage).toBe('enrich');
    expect(m.counts).toEqual({ processed: 5, succeeded: 5, failed: 0, skipped: 282 });
    expect(m.ok).toBe(true);
    expect(m.exit_code).toBe(0);
  });

  it('maps the 287/287 total-failure (incident)', () => {
    const m = buildEnrichManifest('r1', 'a', 'b', { enriched: 0, skipped: 0, failed: 287, errors: [], relatedPairs: 0, written: 0 });
    expect(m.counts).toEqual({ processed: 287, succeeded: 0, failed: 287, skipped: 0 });
    expect(m.ok).toBe(false);
    expect(m.exit_code).toBe(1);
  });

  it('flags failure when load/write errors occurred even if no summarize failed', () => {
    const m = buildEnrichManifest('r1', 'a', 'b', { enriched: 3, skipped: 1, failed: 0, errors: ['load x: boom'], relatedPairs: 2, written: 3 });
    expect(m.ok).toBe(false);
    expect(m.exit_code).toBe(1);
    expect(m.errors).toContain('load x: boom');
  });
});
