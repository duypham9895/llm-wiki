import type { DiscoveredItem, PrdKind, SyncMeta } from './types.js';

export function normalizeEscapes(md: string): string {
  return md.replace(/\\([[\]])/g, '$1');
}

export function resolveNotionLinks(
  md: string,
  opts: { handleByUuid: Map<string, string>; urlByUuid: Map<string, string> },
): string {
  return md.replace(/\[\[notion:([0-9a-fA-F-]+)\|([^\]]*)\]\]/g, (_m, uuid: string, label: string) => {
    const handle = opts.handleByUuid.get(uuid);
    if (handle) return `[[${handle}]]`;
    const url = opts.urlByUuid.get(uuid) ?? `https://www.notion.so/${uuid.replace(/-/g, '')}`;
    return `[${label}](${url})`;
  });
}

type Props = Record<string, any>;

export function extractUniqueId(properties: Record<string, any> | undefined, key = 'ID'): string | null {
  const u = properties?.[key]?.unique_id; if (!u) return null;
  return u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
}

function titleText(p: Props, key: string): string | null {
  const v = p[key]; if (!v) return null;
  const raw = v.title ?? v.rich_text;
  const arr = Array.isArray(raw) ? raw : [];
  const t = arr.map((r: any) => r.plain_text ?? '').join('').trim();
  return t || null;
}
function selectName(p: Props, key: string): string | null {
  return p[key]?.select?.name ?? p[key]?.status?.name ?? null;
}
function multiNames(p: Props, key: string): string[] {
  return (p[key]?.multi_select ?? []).map((o: any) => o.name);
}
function uniqueId(p: Props, key: string): string | null {
  return extractUniqueId(p, key);
}
function peopleNames(p: Props, key: string, names: Record<string, string>): string[] {
  return (p[key]?.people ?? []).map((person: any) => names[person.id] ?? person.id);
}
function numberVal(p: Props, key: string): number | null {
  const n = p[key]?.number; return typeof n === 'number' ? n : null;
}

export function buildSyncMeta(
  item: DiscoveredItem,
  opts: {
    kind: PrdKind; canonical: boolean; userNames: Record<string, string>;
    handleByUuid: Map<string, string>; dependsOnUuids: string[]; trdRefs: string[]; syncedAt: string;
  },
): SyncMeta {
  const p = (item.properties ?? {}) as Props;
  const dependsOn = opts.dependsOnUuids
    .map((u) => opts.handleByUuid.get(u))
    .filter((h): h is string => Boolean(h))
    .map((h) => `[[${h}]]`);
  return {
    id: extractUniqueId(p) ?? item.uuid.slice(0, 8),
    uuid: item.uuid,
    source_url: item.url,
    title: item.title,
    kind: opts.kind,
    canonical: opts.canonical,
    status: selectName(p, 'Status'),
    platform: multiNames(p, 'Platform'),
    strategic_goal: multiNames(p, 'Strategic Goal'),
    short_summary: titleText(p, 'Short Summary'),
    complexity: selectName(p, 'Complexity'),
    rank: titleText(p, 'Rank #'),
    revenue_impact_usd_mo: numberVal(p, 'Revenue Impact ($/mo)'),
    product_pic: peopleNames(p, 'Product PIC', opts.userNames),
    parent: null,
    sub_items: [],
    depends_on: dependsOn,
    trd_refs: opts.trdRefs,
    template_type: null,
    created_time: p['Created time']?.created_time ?? null,
    last_edited: item.lastEdited,
    synced_at: opts.syncedAt,
    removed_from_notion: false,
  };
}

import { NotionToMarkdown } from 'notion-to-md';
import type { Client } from '@notionhq/client';

// Wrap notion-to-md. A custom transformer emits link tokens we resolve later.
export function makeConverter(notion: Client): NotionToMarkdown {
  const n2m = new NotionToMarkdown({ notionClient: notion, config: { parseChildPages: false } });
  n2m.setCustomTransformer('link_to_page', async (block: any) => {
    const id = block.link_to_page?.page_id;
    return id ? `[[notion:${id}|page]]` : false;
  });
  return n2m;
}

export async function blocksToMarkdown(n2m: NotionToMarkdown, pageId: string): Promise<string> {
  const blocks = await n2m.pageToMarkdown(pageId);
  return n2m.toMarkdownString(blocks).parent ?? '';
}
