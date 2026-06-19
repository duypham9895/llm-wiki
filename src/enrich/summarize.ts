import type { LlmClient, ChatMessage } from './llm-client.js';
import type { Summary } from './enrich-types.js';
import { normalizeTags } from './tags.js';

const isSummary = (v: unknown): v is Summary =>
  typeof v === 'object' && v !== null &&
  typeof (v as any).summary === 'string' &&
  Array.isArray((v as any).tags) && (v as any).tags.every((t: unknown) => typeof t === 'string');

export async function summarizeDoc(distilled: string, llm: LlmClient): Promise<Summary> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You summarize product requirement documents. Reply with ONLY a JSON object {"summary": string, "tags": string[]}. The summary is one paragraph: what the PRD delivers, for whom, and its current status. Tags are 3-8 short topic/product/area keywords.' },
    { role: 'user', content: distilled },
  ];
  const raw = await llm.chatJSON<Summary>(messages, { validate: isSummary, label: 'summary' });
  return { summary: raw.summary.trim(), tags: normalizeTags(raw.tags) };
}
