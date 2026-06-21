import { execFileSync } from 'node:child_process';
import type { EnrichConfig } from './enrich-types.js';

export function readEnrichKey(): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-s', 'ringkas-prd-enrich', '-a', 'llm-api-key', '-w'],
    { encoding: 'utf8' },
  ).trim();
}

export function readEnrichKeyFromEnv(env: NodeJS.ProcessEnv): string {
  const k = env.LLM_API_KEY;
  if (!k) throw new Error('LLM_API_KEY env var is required (PRD_SECRETS=env mode)');
  return k;
}

export function loadEnrichConfig(env: NodeJS.ProcessEnv, readKey: () => string): EnrichConfig {
  const vaultPath = env.VAULT_PATH;
  if (!vaultPath) throw new Error('VAULT_PATH env var is required');
  const baseUrl = env.LLM_BASE_URL;
  if (!baseUrl) throw new Error('LLM_BASE_URL env var is required');
  const model = env.LLM_MODEL ?? 'MiniMax-M2';
  const apiKey = readKey();
  if (!apiKey) throw new Error('LLM API key is empty (keychain read failed)');
  return {
    apiKey, baseUrl, model, vaultPath,
    topK: env.TOP_K ? Number(env.TOP_K) : 5,
    distillThreshold: env.DISTILL_THRESHOLD ? Number(env.DISTILL_THRESHOLD) : 8000,
    sectionHeadChars: env.SECTION_HEAD_CHARS ? Number(env.SECTION_HEAD_CHARS) : 200,
    llmTimeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : 60000,
    maxRetries: env.LLM_MAX_RETRIES ? Number(env.LLM_MAX_RETRIES) : 3,
  };
}
