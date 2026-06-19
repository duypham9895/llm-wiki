import { execFileSync } from 'node:child_process';

export interface Config {
  token: string;
  databaseId: string;
  collectionId: string;
  parentPageId: string;
  vaultPath: string;
  searchTerm: string;
  stateFile: string;
  minBodyChars: number;
  apiTimeoutMs: number;
  pageConvertTimeoutMs: number;
}

export function readKeychainToken(): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-s', 'ringkas-prd-sync', '-a', 'notion-token', '-w'],
    { encoding: 'utf8' },
  ).trim();
}

export function loadConfig(env: NodeJS.ProcessEnv, readToken: () => string): Config {
  const vaultPath = env.VAULT_PATH;
  if (!vaultPath) throw new Error('VAULT_PATH env var is required');
  const token = readToken();
  if (!token) throw new Error('Notion token is empty (keychain read failed)');
  return {
    token,
    databaseId: '3f6ac861-35fd-48d0-9252-99a9e202b776',
    collectionId: 'cc477810-e934-412f-b99b-16f4029fba6c',
    parentPageId: 'ff996b90-3c40-4b76-a40d-ad92bae7a1d7',
    vaultPath,
    searchTerm: 'PRD',
    stateFile: env.STATE_FILE ?? '.sync-state.json',
    minBodyChars: env.MIN_BODY_CHARS ? Number(env.MIN_BODY_CHARS) : 300,
    apiTimeoutMs: env.API_TIMEOUT_MS ? Number(env.API_TIMEOUT_MS) : 30000,
    pageConvertTimeoutMs: env.PAGE_CONVERT_TIMEOUT_MS ? Number(env.PAGE_CONVERT_TIMEOUT_MS) : 180000,
  };
}
