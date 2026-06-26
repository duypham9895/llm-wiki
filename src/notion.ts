import { Client } from '@notionhq/client';
import type { DiscoveredItem } from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Maximum time to wait between retries, regardless of what Notion says.
 *  Notion's Retry-After header can be up to 60s for hard rate-limits — honoring
 *  it literally can blow past the parent subprocess's 5-min timeout and turn
 *  a transient 429 into a hard pipeline halt. We honor a small Retry-After,
 *  then fall back to exponential backoff, capped at this ceiling. */
const MAX_BACKOFF_MS = 15_000;

export class NotionRateLimited extends Error {
  /** Seconds until Notion expects the next request to succeed (from Retry-After). */
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`Notion rate-limited. Try again in ${retryAfterSec}s.`);
    this.name = 'NotionRateLimited';
    this.retryAfterSec = retryAfterSec;
  }
}

/** Thrown when the integration token is the wrong type (e.g. personal access
 *  token trying to read a shared database). The fix is on the Notion side, not
 *  in code: create an Internal Integration at Notion → Settings → Connections,
 *  share the Product Backlog DB with it, paste the new token into NOTION_TOKEN. */
export class NotionWrongTokenType extends Error {
  constructor(message: string) {
    super(
      `${message}\n` +
        'FIX: Notion → Settings → Connections → Develop integrations → New integration.\n' +
        '      Copy the Internal Integration Secret (starts with `secret_` or `ntn_I`).\n' +
        '      Share the Product Backlog database with the integration.\n' +
        '      Set NOTION_TOKEN=... in mcp/deploy/.env on the VPS.\n',
    );
    this.name = 'NotionWrongTokenType';
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const sleepFn = opts.sleepFn ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.code;
      const retriable = status === 429 || (typeof status === 'number' && status >= 500);
      if (!retriable || attempt >= retries) {
        // On 429, surface a typed error so callers (e.g. sources.py) can show
        // "rate limited, retry in N seconds" instead of a generic crash.
        if (status === 429) {
          const ra = Number(err?.headers?.['retry-after']);
          throw new NotionRateLimited(Number.isFinite(ra) ? ra : 60);
        }
        // On restricted_resource, the token can't access this resource (almost
        // always: personal access token used on a shared DB). Surface actionable
        // instructions instead of a generic crash.
        if (err?.code === 'restricted_resource' || status === 400 || status === 401) {
          throw new NotionWrongTokenType(
            `Notion API call failed: ${err?.code ?? status} — ${err?.message ?? 'unknown error'}.`,
          );
        }
        throw err;
      }
      const retryAfter = Number(err?.headers?.['retry-after']);
      // Honor Retry-After up to MAX_BACKOFF_MS, then exponential fallback.
      const hinted = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(2 ** attempt * 500, MAX_BACKOFF_MS);
      const waitMs = Math.min(hinted, MAX_BACKOFF_MS);
      console.warn(`[notion] ${status} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${retries})`);
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
