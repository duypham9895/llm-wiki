import type { DiscoveredItem, PrdKind } from './types.js';

export function classify(item: DiscoveredItem): { kind: PrdKind; canonical: boolean } {
  if (item.resultType === 'database') return { kind: 'db-index', canonical: false };
  if (/\[archived\]|\[experiment/i.test(item.title)) return { kind: 'archived', canonical: false };
  if (item.inBacklogDb) return { kind: 'canonical-prd', canonical: true };
  return { kind: 'satellite', canonical: false };
}
