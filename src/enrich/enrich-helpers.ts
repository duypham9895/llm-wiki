/**
 * Pure helpers shared by the enrich orchestrator.
 * Kept in a separate module so they can be unit-tested
 * without triggering main() in enrich-index.ts.
 */

/**
 * Returns true iff two related arrays are identical:
 * same length and same elements in the same order.
 */
export function relatedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
