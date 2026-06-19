import { expect, test } from 'vitest';
import { summarizeDoc } from '../../src/enrich/summarize.js';
import type { LlmClient } from '../../src/enrich/llm-client.js';

function fakeLlm(reply: unknown): LlmClient {
  return { chatJSON: (async (_m: any, opts: any) => { if (!opts.validate(reply)) throw new Error('bad'); return reply; }) as any };
}

test('returns summary and normalized tags', async () => {
  const llm = fakeLlm({ summary: 'It does X.', tags: ['Saudi CRM', 'crm', 'Email'] });
  const out = await summarizeDoc('Title: PRD X\n...', llm);
  expect(out.summary).toBe('It does X.');
  expect(out.tags).toEqual(['saudi-crm', 'crm', 'email']);
});
