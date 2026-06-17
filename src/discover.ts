import type { DiscoveredItem } from './types.js';

export function mergeDiscovery(
  dbItems: DiscoveredItem[], searchItems: DiscoveredItem[],
): DiscoveredItem[] {
  const byUuid = new Map<string, DiscoveredItem>();
  for (const it of searchItems) byUuid.set(it.uuid, it);
  for (const it of dbItems) byUuid.set(it.uuid, it); // DB wins (overwrites search)
  return [...byUuid.values()];
}
