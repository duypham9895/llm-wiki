import { join } from 'node:path';
import { loadEnrichConfig, readEnrichKey } from './enrich-config.js';
import { makeLlmClient } from './llm-client.js';
import { distill } from './distill.js';
import { summarizeDoc } from './summarize.js';
import { buildRelated, judgeRelated, type RelateDoc } from './relate.js';
import { listPrdFiles, splitFrontmatter, hashBody, writeLlmBlock } from './doc-io.js';
import type { DocRecord } from './enrich-types.js';
import { readFile } from 'node:fs/promises';
import { relatedEqual } from './enrich-helpers.js';

function liftFields(sync: any): { title: string; shortSummary: string | null; status: string | null; platform: string[]; strategicGoal: string[] } {
  return {
    title: sync?.title ?? '(untitled)',
    shortSummary: sync?.short_summary ?? null,
    status: sync?.status ?? null,
    platform: Array.isArray(sync?.platform) ? sync.platform : [],
    strategicGoal: Array.isArray(sync?.strategic_goal) ? sync.strategic_goal : [],
  };
}


async function main(): Promise<number> {
  const cfg = loadEnrichConfig(process.env, readEnrichKey);
  const llm = makeLlmClient(cfg);
  const prdsDir = join(cfg.vaultPath, 'PRDs');

  const paths = await listPrdFiles(prdsDir);
  const docs: DocRecord[] = [];
  const errors: string[] = [];

  // Load all docs
  for (const path of paths) {
    try {
      const content = await readFile(path, 'utf8');
      const { sync, llm: llmFields, body } = splitFrontmatter(content);
      const f = liftFields(sync);
      docs.push({
        path, stem: path.split('/').pop()!.replace(/\.md$/, ''),
        syncRaw: sync, llm: llmFields, body, bodyHash: hashBody(body), ...f,
      });
    } catch (err) {
      errors.push(`load ${path}: ${(err as Error).message}`);
    }
  }

  // Phase 1: summarize docs that are new or whose body changed.
  // Fix 2: write each enriched doc immediately for crash-durability.
  let enriched = 0, skipped = 0;

  for (const doc of docs) {
    const needs = doc.llm.summary === null || doc.llm.body_hash !== doc.bodyHash;
    if (!needs) { skipped++; continue; }
    try {
      const distilled = distill({ ...doc, threshold: cfg.distillThreshold, sectionHeadChars: cfg.sectionHeadChars });
      const s = await summarizeDoc(distilled, llm);
      doc.llm = { ...doc.llm, summary: s.summary, tags: s.tags, enriched_at: new Date().toISOString(), body_hash: doc.bodyHash };
      enriched++;
      // Fix 2: write immediately so Phase-1 work survives a Phase-2 crash.
      // doc.llm.related is unchanged from load (P1 does not touch related),
      // so the on-disk file gets the current related plus the new summary/tags.
      try {
        await writeLlmBlock({ path: doc.path, sync: doc.syncRaw, body: doc.body, llm: doc.llm });
      } catch (writeErr) {
        errors.push(`write(p1) ${doc.stem}: ${(writeErr as Error).message}`);
      }
    } catch (err) {
      errors.push(`summarize ${doc.stem}: ${(err as Error).message}`);
    }
  }

  // Phase 2: related over docs that have tags (skip ones with no summary yet)
  const relatable: RelateDoc[] = docs
    .filter((d) => d.llm.summary !== null)
    .map((d) => ({ stem: d.stem, summary: d.llm.summary!, tags: d.llm.tags, platform: d.platform, strategicGoal: d.strategicGoal }));
  const relatedMap = await buildRelated(relatable, cfg.topK, (a, b) => judgeRelated(a, b, llm));
  let relatedPairs = 0;
  let written = 0;

  for (const doc of docs) {
    const rel = relatedMap.get(doc.stem);
    if (rel) {
      relatedPairs += rel.length;
      const oldRelated = doc.llm.related;
      if (!relatedEqual(oldRelated, rel)) {
        // Dirty-gate: only write in Phase 2 if the computed related[] differs from
        // what this doc already had (oldRelated, captured above before reassignment).
        // Docs whose related is unchanged are not rewritten here; a doc enriched in
        // Phase 1 was already persisted with its summary/tags, so its final on-disk
        // state stays complete whether or not this Phase-2 write fires.
        doc.llm.related = rel;
        try {
          await writeLlmBlock({ path: doc.path, sync: doc.syncRaw, body: doc.body, llm: doc.llm });
          written++;
        } catch (err) {
          errors.push(`write(p2) ${doc.stem}: ${(err as Error).message}`);
        }
      }
    }
  }

  console.log(`enriched ${enriched} · skipped ${skipped} · related-links ${relatedPairs} · errors ${errors.length} · written ${written}`);
  if (errors.length) { console.error('Errors:\n' + errors.map((e) => '  - ' + e).join('\n')); return 1; }
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
