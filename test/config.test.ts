import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

const fakeEnv = { VAULT_PATH: '/tmp/vault' } as NodeJS.ProcessEnv;

test('loadConfig fills defaults and injected token', () => {
  const cfg = loadConfig(fakeEnv, () => 'secret-token');
  expect(cfg.token).toBe('secret-token');
  expect(cfg.databaseId).toBe('3f6ac861-35fd-48d0-9252-99a9e202b776');
  expect(cfg.vaultPath).toBe('/tmp/vault');
  expect(cfg.searchTerm).toBe('PRD');
});

test('loadConfig throws when vault path missing', () => {
  expect(() => loadConfig({} as NodeJS.ProcessEnv, () => 't')).toThrow(/VAULT_PATH/);
});

test('loadConfig throws when token empty', () => {
  expect(() => loadConfig(fakeEnv, () => '')).toThrow(/token/i);
});

test('loadConfig defaults minBodyChars=300 and apiTimeoutMs=30000', () => {
  const cfg = loadConfig(fakeEnv, () => 'secret-token');
  expect(cfg.minBodyChars).toBe(300);
  expect(cfg.apiTimeoutMs).toBe(30000);
});

test('loadConfig parses MIN_BODY_CHARS and API_TIMEOUT_MS from env', () => {
  const env = { ...fakeEnv, MIN_BODY_CHARS: '500', API_TIMEOUT_MS: '60000' } as NodeJS.ProcessEnv;
  const cfg = loadConfig(env, () => 'secret-token');
  expect(cfg.minBodyChars).toBe(500);
  expect(cfg.apiTimeoutMs).toBe(60000);
});
