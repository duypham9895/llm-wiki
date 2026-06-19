import { expect, test } from 'vitest';
import { buildRelated, type RelateDoc } from '../../src/enrich/relate.js';

const d = (stem: string, tags: string[]): RelateDoc => ({ stem, summary: stem, tags, platform: [], strategicGoal: [] });

test('confirmed links are symmetric and wikilinked', async () => {
  const a = d('a', ['x']); const b = d('b', ['x']); const c = d('c', ['q']);
  // judge: a-b related, anything with c not related
  const judge = async (x: RelateDoc, y: RelateDoc) => [x.stem, y.stem].every((s) => s !== 'c');
  const map = await buildRelated([a, b, c], 5, judge);
  expect(map.get('a')).toEqual(['[[b]]']);
  expect(map.get('b')).toEqual(['[[a]]']);   // symmetric
  expect(map.get('c') ?? []).toEqual([]);
});

test('a throwing judge is treated as not-related (no crash)', async () => {
  const a = d('a', ['x']); const b = d('b', ['x']);
  const judge = async () => { throw new Error('llm down'); };
  const map = await buildRelated([a, b], 5, judge);
  expect(map.get('a') ?? []).toEqual([]);
  expect(map.get('b') ?? []).toEqual([]);
});

test('no duplicate links when both directions judged true', async () => {
  const a = d('a', ['x']); const b = d('b', ['x']);
  const judge = async () => true;
  const map = await buildRelated([a, b], 5, judge);
  expect(map.get('a')).toEqual(['[[b]]']);
  expect(map.get('b')).toEqual(['[[a]]']);
});
