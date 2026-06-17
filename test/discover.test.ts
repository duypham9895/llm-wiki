import { expect, test } from 'vitest';
import { mergeDiscovery } from '../src/discover.js';
import type { DiscoveredItem } from '../src/types.js';

const mk = (uuid: string, inDb: boolean): DiscoveredItem => ({
  uuid, title: 'T', url: 'u', resultType: 'page', inBacklogDb: inDb, lastEdited: 'x',
  properties: inDb ? { x: 1 } : undefined,
});

test('union dedupes by uuid, DB item wins', () => {
  const merged = mergeDiscovery([mk('a', true)], [mk('a', false), mk('b', false)]);
  expect(merged).toHaveLength(2);
  const a = merged.find((m) => m.uuid === 'a')!;
  expect(a.inBacklogDb).toBe(true);
  expect(a.properties).toEqual({ x: 1 });
});
