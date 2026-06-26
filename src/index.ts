import { Client } from '@notionhq/client';
import { join } from 'node:path';
import { loadConfig, readKeychainToken, readNotionTokenFromEnv } from './config.js';
import { loadState, saveState, needsSync, findRemoved } from './state.js';
import { enumerateDatabase, resolveUsers } from './notion.js';
import { classify } from './classify.js';
import { filenameStem } from './naming.js';
import { makeConverter, blocksToMarkdown, normalizeEscapes, resolveNotionLinks, buildSyncMeta, extractUniqueId } from './convert.js';
import { withDeadline } from './timeout.js';
import { hasRealContent } from './content.js';
import { downloadImages } from './assets.js';
import { writeMarkdown, archiveFile } from './writer.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeManifest, type StageManifest } from './manifest.js';

const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });

export function buildSyncManifest(
  runId: string, startedAt: string, finishedAt: string,
  r: { synced: number; skipped: number; archived: number; errors: string[] },
): StageManifest {
  const failed = r.errors.length;
  const succeeded = r.synced + r.archived;
  return {
    stage: 'sync', run_id: runId, started_at: startedAt, finished_at: finishedAt,
    ok: failed === 0, exit_code: failed ? 1 : 0,
    counts: { processed: succeeded + failed, succeeded, failed, skipped: r.skipped },
    errors: r.errors.slice(0, 20), extra: { archived: r.archived },
  };
}

async function main(): Promise<number> {
  const reader = process.env.PRD_SECRETS === 'env'
    ? () => readNotionTokenFromEnv(process.env)
    : readKeychainToken;
  const cfg = loadConfig(process.env, reader);
  const notion = new Client({ auth: cfg.token, timeoutMs: cfg.apiTimeoutMs });
  const n2m = makeConverter(notion);
  const prdsDir = join(cfg.vaultPath, 'PRDs');
  const attachmentsDir = join(prdsDir, '_attachments');
  const state = await loadState(cfg.stateFile);
  const syncedAt = new Date().toISOString();
  const runId = process.env.RUN_ID ?? syncedAt;

  // 1. Discover (DB-only; search pass dropped after live run revealed 828 noisy results)
  const items = await enumerateDatabase(notion, cfg.databaseId);
  const presentUuids = new Set(items.map((i) => i.uuid));

  // Precompute handles for wikilink resolution
  const handleByUuid = new Map<string, string>();
  const urlByUuid = new Map<string, string>();
  for (const it of items) {
    const { kind } = classify(it);
    const idStr = extractUniqueId(it.properties as any);
    handleByUuid.set(it.uuid, filenameStem({ kind, id: idStr, title: it.title, uuid: it.uuid }));
    urlByUuid.set(it.uuid, it.url);
  }

  let synced = 0, skipped = 0, archived = 0;
  const errors: string[] = [];

  // 2. Sync each item
  for (const item of items) {
    try {
      if (!needsSync(state.pages[item.uuid], item.lastEdited)) { skipped++; continue; }
      const { kind, canonical } = classify(item);

      let body: string;
      if (kind === 'db-index') {
        body = `# ${item.title}\n\n_Notion database — rows not expanded._\n\n[Open in Notion](${item.url})\n`;
      } else {
        const raw = await withDeadline(
          blocksToMarkdown(n2m, item.uuid),
          cfg.pageConvertTimeoutMs,
          `convert ${item.title}`,
        );
        body = resolveNotionLinks(normalizeEscapes(raw), { handleByUuid, urlByUuid });
      }

      // Skip stubs: 'Not Started' rows with no meaningful body content
      if (!hasRealContent(body, cfg.minBodyChars)) { skipped++; continue; }

      // resolve people referenced by this item's properties
      const pic = ((item.properties as any)?.['Product PIC']?.people ?? []).map((p: any) => p.id);
      await resolveUsers(notion, pic, state.users);

      const stem = handleByUuid.get(item.uuid)!;
      body = await downloadImages(body, {
        id: stem, attachmentsDir, vaultRelativePrefix: '_attachments',
        fetchFn: fetchWithTimeout, writeFileFn: (p, d) => writeFile(p, d), mkdirFn: (p) => mkdir(p, { recursive: true }).then(() => {}),
      });

      const sync = buildSyncMeta(item, {
        kind, canonical, userNames: state.users, handleByUuid,
        dependsOnUuids: [], trdRefs: [], syncedAt,
      });
      const filename = await writeMarkdown({ dir: prdsDir, stem, sync, body });
      if (filename === null) {
        // Fail-safe skip (spec §7): existing file's llm block was unparseable, so it was
        // not overwritten. Leave its prior state entry untouched and count it as skipped.
        skipped++;
        continue;
      }
      state.pages[item.uuid] = { id: sync.id, filename, last_edited: item.lastEdited, synced_at: syncedAt, kind };
      synced++;

      // Checkpoint state every 25 synced pages. The first full sync of a large
      // backlog (700+ items) can exceed the "Run now" subprocess timeout; without
      // periodic checkpoints a kill mid-loop discards all progress and the next run
      // restarts from zero. Flushing here makes incremental sync resilient to kills:
      // each run resumes where the last left off (needsSync skips already-synced pages).
      if (synced % 25 === 0) {
        await saveState(cfg.stateFile, state);
      }
    } catch (err) {
      errors.push(`${item.title} (${item.uuid}): ${(err as Error).message}`);
    }
  }

  // 3. Archive removed
  for (const uuid of findRemoved(state, presentUuids)) {
    try {
      await archiveFile({ dir: prdsDir, filename: state.pages[uuid].filename });
      archived++;
      delete state.pages[uuid];
    } catch (err) {
      errors.push(`archive ${uuid}: ${(err as Error).message}`);
    }
  }

  await saveState(cfg.stateFile, state);

  await writeManifest(cfg.vaultPath, runId, buildSyncManifest(runId, syncedAt, new Date().toISOString(),
    { synced, skipped, archived, errors }));

  console.log(`synced ${synced} · skipped ${skipped} · archived ${archived} · errors ${errors.length}`);
  if (errors.length) { console.error('Errors:\n' + errors.map((e) => '  - ' + e).join('\n')); return 1; }
  return 0;
}

// Only run the pipeline when executed directly, NOT when imported by a test.
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
}
