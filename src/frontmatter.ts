import { parse, stringify } from 'yaml';
import type { SyncMeta } from './types.js';

export const DEFAULT_LLM_BLOCK = 'llm:\n  summary: null\n  tags: []\n  related: []\n';

export function buildSyncBlock(sync: SyncMeta): string {
  // stringify a single-key mapping so output is "sync:\n  ...":
  return stringify({ sync }, { lineWidth: 0 });
}

/**
 * Result of inspecting an existing file's frontmatter.
 * - llmRaw: the re-serialized `llm:` block (single-key YAML text ending in newline),
 *   or null when there is no frontmatter / no `llm` key.
 * - parseError: true ONLY when frontmatter was present but could not be parsed as YAML.
 *   The writer uses this to fail safe (never overwrite an existing file whose llm block
 *   it cannot read) — see spec §7.
 */
export interface ParsedExisting {
  llmRaw: string | null;
  parseError?: boolean;
}

/**
 * Extract the `llm` block from an existing file STRUCTURALLY.
 *
 * The previous implementation sliced from the `llm:` line to the end of the
 * frontmatter, which assumed `llm:` was the LAST key. For hand-edited files (or files
 * re-serialized by a future enrichment tool) where `llm:` precedes `sync:`, that slice
 * wrongly captured the trailing `sync:` block too, producing duplicate `sync` keys on
 * rewrite and corrupting the file (yaml.parse throws "Map keys must be unique").
 *
 * We now parse the whole frontmatter region as YAML and pull out ONLY the `llm` subtree,
 * regardless of key order, then re-serialize just that subtree. This is value-preserving
 * rather than byte-for-byte: B's llm content (summary/tags/related plus any extra keys)
 * survives unchanged in MEANING — re-parsing the output yields the same data — though the
 * exact bytes (e.g. flow `[a]` vs block `- a`, quoting) may differ.
 */
export function parseExisting(content: string): ParsedExisting {
  if (!content.startsWith('---\n')) return { llmRaw: null };
  // Find the closing fence: a line that is exactly "---" (followed by newline or EOF),
  // searching only AFTER the opening fence at index 4. This prevents a sync field value
  // containing "\n---" (but not followed by \n or EOF) from being mistaken as the fence.
  const fenceRe = /\n---(?:\n|$)/g;
  fenceRe.lastIndex = 4;
  const m = fenceRe.exec(content);
  if (!m) return { llmRaw: null };
  const end = m.index; // position of the '\n' before the closing '---'
  const fm = content.slice(4, end + 1); // frontmatter text, includes trailing newline

  let data: unknown;
  try {
    data = parse(fm);
  } catch {
    // Frontmatter present but unparseable — signal so the writer fails safe.
    return { llmRaw: null, parseError: true };
  }
  if (data === null || typeof data !== 'object') return { llmRaw: null };
  const llm = (data as Record<string, unknown>).llm;
  if (llm === undefined) return { llmRaw: null };
  // Re-serialize JUST the llm subtree as a single-key mapping: "llm:\n  ...":
  return { llmRaw: stringify({ llm }, { lineWidth: 0 }) };
}

export function composeFile(sync: SyncMeta, llmRaw: string | null, body: string): string {
  const syncBlock = buildSyncBlock(sync); // ends with newline, emits sync: FIRST
  const llm = llmRaw ?? DEFAULT_LLM_BLOCK; // ends with newline, emits llm: SECOND
  const bodyOut = body.endsWith('\n') ? body : `${body}\n`;
  return `---\n${syncBlock}${llm}---\n\n${bodyOut}`;
}
