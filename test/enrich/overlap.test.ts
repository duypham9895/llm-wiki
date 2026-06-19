import { expect, test } from 'vitest';
import { overlapScore, topKCandidates } from '../../src/enrich/overlap.js';

const d = (stem: string, tags: string[], platform: string[] = [], strategicGoal: string[] = []) => ({ stem, tags, platform, strategicGoal });

test('overlapScore weights tags double', () => {
  expect(overlapScore(d('a', ['x', 'y'], ['P']), d('b', ['x'], ['P']))).toBe(2 * 1 + 1); // 1 shared tag*2 + 1 shared platform
});

test('topK excludes self, drops zero-overlap, ranks by score then stem', () => {
  const a = d('a', ['x', 'y'], ['P']);
  const b = d('b', ['x', 'y'], ['P']);   // score 5
  const c = d('c', ['x'], []);            // score 2
  const z = d('z', ['q'], []);            // score 0 -> dropped
  const out = topKCandidates(a, [a, b, c, z], 5).map((o) => o.stem);
  expect(out).toEqual(['b', 'c']);
});

test('topK respects k', () => {
  const a = d('a', ['x']);
  const b = d('b', ['x']);
  const c = d('c', ['x']);
  const out = topKCandidates(a, [a, b, c], 1).map((o) => o.stem);
  expect(out).toEqual(['b']);
});
