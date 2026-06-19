export type PrdKind = 'canonical-prd' | 'satellite' | 'archived' | 'db-index';

export interface DiscoveredItem {
  uuid: string;                 // dashed Notion id
  title: string;
  url: string;
  resultType: 'page' | 'database';
  inBacklogDb: boolean;         // true when found via DB enumeration
  lastEdited: string;           // ISO-8601
  properties?: Record<string, unknown>; // raw DB column values (undefined for search-only)
}

export interface SyncMeta {
  id: string;
  uuid: string;
  source_url: string;
  title: string;
  kind: PrdKind;
  canonical: boolean;
  status: string | null;
  platform: string[];
  strategic_goal: string[];
  short_summary: string | null;
  complexity: string | null;
  rank: string | null;
  revenue_impact_usd_mo: number | null;
  product_pic: string[];
  parent: string | null;        // "[[handle]]" or null
  sub_items: string[];          // ["[[handle]]", ...]
  depends_on: string[];         // from in-body mentions to synced targets
  trd_refs: string[];           // "Label — url" plain references
  template_type: string | null;
  created_time: string | null;
  last_edited: string;
  synced_at: string;
  removed_from_notion: boolean;
}

export interface LlmMeta {
  summary: string | null;
  tags: string[];
  related: string[];
}

export interface StateEntry {
  id: string;
  filename: string;             // e.g. "EP-827-client-management.md"
  last_edited: string;
  synced_at: string;
  kind: PrdKind;
}

export interface SyncState {
  pages: Record<string, StateEntry>; // uuid -> entry
  users: Record<string, string>;     // notion userId -> resolved name
}
