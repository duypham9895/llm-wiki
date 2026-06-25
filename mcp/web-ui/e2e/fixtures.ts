import { test as base, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnv(): { email: string; password: string } {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(__dirname, '../../deploy/.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const get = (k: string) =>
    text.split('\n').find((l) => l.startsWith(`${k}=`))?.split('=')[1]?.trim() ?? '';
  return { email: get('ADMIN_EMAIL'), password: get('ADMIN_PASSWORD') };
}

export const test = base.extend<{ admin: { email: string; password: string } }>({
  admin: async ({}, use) => {
    await use(loadEnv());
  },
});

export { expect };