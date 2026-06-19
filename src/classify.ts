import type { DiscoveredItem, PrdKind } from './types.js';

// NOTE: under DB-only discovery (see spec §3, revised 2026-06-18) the only kinds actually produced
// are canonical-prd and archived. The satellite/db-index branches are retained (harmless) for a
// possible future search-based scope, where database results and out-of-DB pages would appear.
export function classify(item: DiscoveredItem): { kind: PrdKind; canonical: boolean } {
  if (item.resultType === 'database') return { kind: 'db-index', canonical: false };
  if (/\[archived\]|\[experiment/i.test(item.title)) return { kind: 'archived', canonical: false };
  if (item.inBacklogDb) return { kind: 'canonical-prd', canonical: true };
  return { kind: 'satellite', canonical: false };
}
