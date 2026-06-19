function sharedCount(a: string[], b: string[]): number {
  const set = new Set(a);
  let n = 0;
  for (const x of b) if (set.has(x)) n++;
  return n;
}

export function overlapScore(
  a: { tags: string[]; platform: string[]; strategicGoal: string[] },
  b: { tags: string[]; platform: string[]; strategicGoal: string[] },
): number {
  return 2 * sharedCount(a.tags, b.tags) + sharedCount(a.platform, b.platform) + sharedCount(a.strategicGoal, b.strategicGoal);
}

export function topKCandidates<T extends { stem: string; tags: string[]; platform: string[]; strategicGoal: string[] }>(
  doc: T, all: T[], k: number,
): T[] {
  return all
    .filter((o) => o.stem !== doc.stem)
    .map((o) => ({ o, s: overlapScore(doc, o) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => (y.s - x.s) || x.o.stem.localeCompare(y.o.stem))
    .slice(0, k)
    .map((x) => x.o);
}
