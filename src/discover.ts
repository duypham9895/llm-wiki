import type { DiscoveredItem } from './types.js';

// NOTE: not currently called — DB-only discovery (see spec §3, revised 2026-06-18). Retained for a possible future search-based scope.
export function mergeDiscovery(
  dbItems: DiscoveredItem[], searchItems: DiscoveredItem[],
): DiscoveredItem[] {
  const byUuid = new Map<string, DiscoveredItem>();
  for (const it of searchItems) byUuid.set(it.uuid, it);
  for (const it of dbItems) byUuid.set(it.uuid, it); // DB wins (overwrites search)
  return [...byUuid.values()];
}
