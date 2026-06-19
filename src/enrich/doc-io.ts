import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { parseExisting, composeFile } from '../frontmatter.js';
import type { SyncMeta } from '../types.js';
import type { LlmFields } from './enrich-types.js';

export interface FsLikeMin {
  readFile: (p: string, enc?: any) => Promise<string>;
  writeFile: (p: string, d: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
}
const defaultFs: FsLikeMin = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, d) => writeFile(p, d, 'utf8'),
  rename: (a, b) => rename(a, b),
};

export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function splitFrontmatter(content: string): { sync: unknown; llm: LlmFields; body: string } {
  if (!content.startsWith('---\n')) throw new Error('no frontmatter');
  const fenceRe = /\n---(?:\n|$)/g;
  fenceRe.lastIndex = 4;
  const m = fenceRe.exec(content);
  if (!m) throw new Error('no closing fence');
  const fm = content.slice(4, m.index + 1);
  const body = content.slice(m.index + 1).replace(/^---\n?/, '').replace(/^\n/, '');
  const data = parse(fm) as Record<string, unknown>;
  const llmObj = (data?.llm ?? {}) as Record<string, unknown>;
  const llm: LlmFields = {
    summary: (llmObj.summary as string | null) ?? null,
    tags: Array.isArray(llmObj.tags) ? (llmObj.tags as string[]) : [],
    related: Array.isArray(llmObj.related) ? (llmObj.related as string[]) : [],
    enriched_at: llmObj.enriched_at as string | undefined,
    body_hash: llmObj.body_hash as string | undefined,
  };
  return { sync: data?.sync, llm, body };
}

export function buildLlmRaw(llm: LlmFields): string {
  // omit undefined bookkeeping keys for cleanliness
  const obj: Record<string, unknown> = { summary: llm.summary, tags: llm.tags, related: llm.related };
  if (llm.enriched_at !== undefined) obj.enriched_at = llm.enriched_at;
  if (llm.body_hash !== undefined) obj.body_hash = llm.body_hash;
  return stringify({ llm: obj }, { lineWidth: 0 });
}

export async function writeLlmBlock(opts: {
  path: string; sync: unknown; body: string; llm: LlmFields; fs?: FsLikeMin;
}): Promise<void> {
  const fs = opts.fs ?? defaultFs;
  // fail safe: if the on-disk file can't be parsed, do not overwrite it
  const existing = await fs.readFile(opts.path);
  const probe = parseExisting(existing);
  if (probe.parseError) throw new Error(`refusing to overwrite unparseable frontmatter: ${opts.path}`);
  const content = composeFile(opts.sync as SyncMeta, buildLlmRaw(opts.llm), opts.body);
  const tmp = `${opts.path}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, opts.path);
}

export async function listPrdFiles(prdsDir: string): Promise<string[]> {
  const entries = await readdir(prdsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
    .map((e) => join(prdsDir, e.name))
    .sort();
}
