import { expect, test } from 'vitest';
import { loadEnrichConfig } from '../../src/enrich/enrich-config.js';

const env = { VAULT_PATH: '/tmp/v', LLM_BASE_URL: 'https://api.x/v1', LLM_MODEL: 'MiniMax-M2' } as unknown as NodeJS.ProcessEnv;

test('loads config with injected key and defaults', () => {
  const c = loadEnrichConfig(env, () => 'sk-key');
  expect(c.apiKey).toBe('sk-key');
  expect(c.baseUrl).toBe('https://api.x/v1');
  expect(c.model).toBe('MiniMax-M2');
  expect(c.vaultPath).toBe('/tmp/v');
  expect(c.topK).toBe(5);
  expect(c.distillThreshold).toBe(8000);
  expect(c.llmTimeoutMs).toBe(60000);
});

test('throws when vault path missing', () => {
  expect(() => loadEnrichConfig({} as NodeJS.ProcessEnv, () => 'k')).toThrow(/VAULT_PATH/);
});
test('throws when base url missing', () => {
  expect(() => loadEnrichConfig({ VAULT_PATH: '/tmp/v' } as unknown as NodeJS.ProcessEnv, () => 'k')).toThrow(/LLM_BASE_URL/);
});
test('throws when key empty', () => {
  expect(() => loadEnrichConfig(env, () => '')).toThrow(/key/i);
});
test('env overrides for topK and threshold parse to numbers', () => {
  const c = loadEnrichConfig({ ...env, TOP_K: '8', DISTILL_THRESHOLD: '12000' } as unknown as NodeJS.ProcessEnv, () => 'k');
  expect(c.topK).toBe(8);
  expect(c.distillThreshold).toBe(12000);
});
