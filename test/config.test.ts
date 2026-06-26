import { expect, test } from 'vitest';
import { loadConfig, readNotionTokenFromEnv } from '../src/config.js';

const fakeEnv = { VAULT_PATH: '/tmp/vault' } as NodeJS.ProcessEnv;

test('loadConfig fills defaults and injected token', () => {
  const cfg = loadConfig(fakeEnv, () => 'secret-token');
  expect(cfg.token).toBe('secret-token');
  expect(cfg.databaseId).toBe('3f6ac861-35fd-48d0-9252-99a9e202b776');
  expect(cfg.vaultPath).toBe('/tmp/vault');
});

test('loadConfig throws when vault path missing', () => {
  expect(() => loadConfig({} as NodeJS.ProcessEnv, () => 't')).toThrow(/VAULT_PATH/);
});

test('stateFile defaults INSIDE the vault (persistent), not cwd', () => {
  const cfg = loadConfig(fakeEnv, () => 'secret-token');
  expect(cfg.stateFile).toBe('/tmp/vault/.sync-state.json');
});

test('STATE_FILE relative env is resolved under the vault', () => {
  const env = { ...fakeEnv, STATE_FILE: 'custom-state.json' } as NodeJS.ProcessEnv;
  const cfg = loadConfig(env, () => 'secret-token');
  expect(cfg.stateFile).toBe('/tmp/vault/custom-state.json');
});

test('STATE_FILE absolute env is used verbatim', () => {
  const env = { ...fakeEnv, STATE_FILE: '/data/state.json' } as NodeJS.ProcessEnv;
  const cfg = loadConfig(env, () => 'secret-token');
  expect(cfg.stateFile).toBe('/data/state.json');
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

test('loadConfig defaults pageConvertTimeoutMs=180000', () => {
  const cfg = loadConfig(fakeEnv, () => 'secret-token');
  expect(cfg.pageConvertTimeoutMs).toBe(180000);
});

test('loadConfig parses PAGE_CONVERT_TIMEOUT_MS from env', () => {
  const env = { ...fakeEnv, PAGE_CONVERT_TIMEOUT_MS: '120000' } as NodeJS.ProcessEnv;
  const cfg = loadConfig(env, () => 'secret-token');
  expect(cfg.pageConvertTimeoutMs).toBe(120000);
});

test('readNotionTokenFromEnv returns NOTION_TOKEN from env', () => {
  expect(readNotionTokenFromEnv({ NOTION_TOKEN: 'secret-123' } as any)).toBe('secret-123');
});

test('readNotionTokenFromEnv throws when NOTION_TOKEN is missing', () => {
  expect(() => readNotionTokenFromEnv({} as any)).toThrow(/NOTION_TOKEN/);
});
