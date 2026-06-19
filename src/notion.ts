import { Client } from '@notionhq/client';
import type { DiscoveredItem } from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  const sleepFn = opts.sleepFn ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.code;
      const retriable = status === 429 || (typeof status === 'number' && status >= 500);
      if (!retriable || attempt >= retries) throw err;
      const retryAfter = Number(err?.headers?.['retry-after']);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(2 ** attempt * 500, 8000);
      await sleepFn(waitMs);
      attempt++;
    }
  }
}

export async function enumerateDatabase(notion: Client, databaseId: string): Promise<DiscoveredItem[]> {
  const out: DiscoveredItem[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await withRetry(() =>
      notion.databases.query({ database_id: databaseId, start_cursor: cursor, page_size: 100 }));
    for (const page of res.results) {
      out.push({
        uuid: page.id,
        title: extractTitle(page.properties),
        url: page.url,
        resultType: 'page',
        inBacklogDb: true,
        lastEdited: page.last_edited_time,
        properties: page.properties,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

// NOTE: not currently called — DB-only discovery (see spec §3, revised 2026-06-18). Retained for a possible future search-based scope.
export async function searchPrd(notion: Client, term: string): Promise<DiscoveredItem[]> {
  const out: DiscoveredItem[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await withRetry(() => notion.search({ query: term, start_cursor: cursor, page_size: 100 }));
    for (const r of res.results) {
      out.push({
        uuid: r.id,
        title: r.object === 'database' ? extractDbTitle(r) : extractTitle(r.properties),
        url: r.url ?? '',
        resultType: r.object === 'database' ? 'database' : 'page',
        inBacklogDb: false,
        lastEdited: r.last_edited_time ?? '',
        properties: r.properties,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

export async function resolveUsers(
  notion: Client, ids: string[], cache: Record<string, string>,
): Promise<Record<string, string>> {
  for (const id of ids) {
    if (cache[id]) continue;
    try {
      const u: any = await withRetry(() => notion.users.retrieve({ user_id: id }));
      cache[id] = u.name ?? id;
    } catch { cache[id] = id; }
  }
  return cache;
}

function extractTitle(props: any): string {
  if (!props) return 'Untitled';
  for (const v of Object.values<any>(props)) {
    if (v?.type === 'title') return v.title.map((t: any) => t.plain_text).join('') || 'Untitled';
  }
  return 'Untitled';
}

function extractDbTitle(db: any): string {
  return (db.title ?? []).map((t: any) => t.plain_text).join('') || 'Untitled DB';
}
