import { stringify } from 'yaml';
import type { SyncMeta } from './types.js';

export const DEFAULT_LLM_BLOCK = 'llm:\n  summary: null\n  tags: []\n  related: []\n';

export function buildSyncBlock(sync: SyncMeta): string {
  // stringify a single-key mapping so output is "sync:\n  ...":
  return stringify({ sync }, { lineWidth: 0 });
}

export function parseExisting(content: string): { llmRaw: string | null } {
  if (!content.startsWith('---\n')) return { llmRaw: null };
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { llmRaw: null };
  const fm = content.slice(4, end + 1); // frontmatter text, includes trailing newline
  const llmIdx = fm.search(/^llm:/m);
  if (llmIdx === -1) return { llmRaw: null };
  return { llmRaw: fm.slice(llmIdx) };
}

export function composeFile(sync: SyncMeta, llmRaw: string | null, body: string): string {
  const syncBlock = buildSyncBlock(sync); // ends with newline
  const llm = llmRaw ?? DEFAULT_LLM_BLOCK; // ends with newline
  const bodyOut = body.endsWith('\n') ? body : `${body}\n`;
  return `---\n${syncBlock}${llm}---\n\n${bodyOut}`;
}
