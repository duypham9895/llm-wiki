import type { LlmClient, ChatMessage } from './llm-client.js';
import type { Verdict } from './enrich-types.js';
import { topKCandidates } from './overlap.js';

export type RelateDoc = { stem: string; summary: string; tags: string[]; platform: string[]; strategicGoal: string[] };

const isVerdict = (v: unknown): v is Verdict =>
  typeof v === 'object' && v !== null && typeof (v as any).related === 'boolean';

export async function judgeRelated(a: RelateDoc, b: RelateDoc, llm: LlmClient): Promise<boolean> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You decide whether two product requirement documents are directly related (shared feature area, dependency, or subsystem). Reply with ONLY {"related": boolean, "reason": string}.' },
    { role: 'user', content: `Doc A: ${a.summary}\n\nDoc B: ${b.summary}` },
  ];
  const v = await llm.chatJSON<Verdict>(messages, { validate: isVerdict, label: 'verdict' });
  return v.related;
}

export async function buildRelated(
  docs: RelateDoc[], k: number, judge: (a: RelateDoc, b: RelateDoc) => Promise<boolean>,
): Promise<Map<string, string[]>> {
  // ordered set of related stems per doc, preserving candidate (overlap) order
  const links = new Map<string, string[]>();
  for (const d of docs) links.set(d.stem, []);
  const add = (from: string, to: string) => {
    const arr = links.get(from)!;
    if (!arr.includes(`[[${to}]]`)) arr.push(`[[${to}]]`);
  };

  for (const doc of docs) {
    const candidates = topKCandidates(doc, docs, k);
    for (const cand of candidates) {
      let related = false;
      try {
        related = await judge(doc, cand);
      } catch {
        related = false; // a failed judge is "not related", never aborts the pass
      }
      if (related) {
        add(doc.stem, cand.stem);
        add(cand.stem, doc.stem); // symmetric
      }
    }
  }
  return links;
}
