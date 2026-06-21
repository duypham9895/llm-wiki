// test/orchestrate-main.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildRunId, makeHealthcheckPing } from '../src/orchestrate-main.js';

describe('buildRunId', () => {
  it('uses an ISO timestamp', () => {
    expect(buildRunId('2026-06-20T03:00:00.000Z')).toBe('2026-06-20T03:00:00.000Z');
  });
});

describe('makeHealthcheckPing', () => {
  it('is a no-op when no url is configured', async () => {
    const fetchFn = vi.fn();
    await makeHealthcheckPing(undefined, fetchFn)();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('pings the url when configured', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }));
    await makeHealthcheckPing('https://hc.example/abc', fetchFn as any)();
    expect(fetchFn).toHaveBeenCalledWith('https://hc.example/abc');
  });
  it('never throws if the ping fails', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network'); });
    await expect(makeHealthcheckPing('https://hc.example/abc', fetchFn as any)()).resolves.toBeUndefined();
  });
});
