import { expect, test } from 'vitest';
import { makeLlmClient } from '../../src/enrich/llm-client.js';

type Out = { summary: string };
const isOut = (v: unknown): v is Out =>
  typeof v === 'object' && v !== null && typeof (v as any).summary === 'string';

function fetchReturning(bodies: string[]): typeof fetch {
  let i = 0;
  return (async () => {
    const content = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;
}

test('parses valid JSON content and validates', async () => {
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 2, fetchFn: fetchReturning(['{"summary":"ok"}']), sleepFn: async () => {} });
  const r = await c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' });
  expect(r.summary).toBe('ok');
});

test('retries once on invalid JSON then succeeds', async () => {
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 3, fetchFn: fetchReturning(['not json', '{"summary":"recovered"}']), sleepFn: async () => {} });
  const r = await c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' });
  expect(r.summary).toBe('recovered');
});

test('throws after exhausting retries on persistently invalid output', async () => {
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 2, fetchFn: fetchReturning(['nope']), sleepFn: async () => {} });
  await expect(c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' })).rejects.toThrow();
});

test('retries on HTTP 500 then succeeds', async () => {
  let i = 0;
  const fetchFn = (async () => {
    i++;
    if (i < 2) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"summary":"ok"}' } }] }) };
  }) as unknown as typeof fetch;
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 3, fetchFn, sleepFn: async () => {} });
  const r = await c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' });
  expect(r.summary).toBe('ok');
});

test('timeout/infra error fails fast without content-retries', async () => {
  let callCount = 0;
  const fetchFn = (async () => {
    callCount++;
    throw new Error('the operation timed out');
  }) as unknown as typeof fetch;
  const c = makeLlmClient({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', llmTimeoutMs: 1000, maxRetries: 3, fetchFn, sleepFn: async () => {} });
  await expect(
    c.chatJSON<Out>([{ role: 'user', content: 'hi' }], { validate: isOut, label: 't' }),
  ).rejects.toThrow('the operation timed out');
  expect(callCount).toBe(1);
});
