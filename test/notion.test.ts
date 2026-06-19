import { expect, test } from 'vitest';
import { withRetry } from '../src/notion.js';

test('withRetry retries on 429 then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) { const e: any = new Error('rate'); e.status = 429; e.headers = { 'retry-after': '0' }; throw e; }
    return 'ok';
  }, { retries: 5, sleepFn: async () => {} });
  expect(result).toBe('ok');
  expect(calls).toBe(3);
});

test('withRetry gives up after retries on persistent 500', async () => {
  let calls = 0;
  await expect(withRetry(async () => {
    calls++; const e: any = new Error('server'); e.status = 500; throw e;
  }, { retries: 2, sleepFn: async () => {} })).rejects.toThrow('server');
  expect(calls).toBe(3); // initial + 2 retries
});

test('withRetry does not retry on 404', async () => {
  let calls = 0;
  await expect(withRetry(async () => {
    calls++; const e: any = new Error('missing'); e.status = 404; throw e;
  }, { retries: 3, sleepFn: async () => {} })).rejects.toThrow('missing');
  expect(calls).toBe(1);
});
