import { expect, test } from 'vitest';
import { emptyState, needsSync, findRemoved } from '../src/state.js';
import type { StateEntry } from '../src/types.js';

const entry: StateEntry = {
  id: 'EP-1', filename: 'EP-1-x.md',
  last_edited: '2026-06-01T00:00:00Z', synced_at: '2026-06-01T01:00:00Z', kind: 'canonical-prd',
};

test('needsSync: new item (no entry) => true', () => {
  expect(needsSync(undefined, '2026-06-01T00:00:00Z')).toBe(true);
});
test('needsSync: unchanged last_edited => false', () => {
  expect(needsSync(entry, '2026-06-01T00:00:00Z')).toBe(false);
});
test('needsSync: newer last_edited => true', () => {
  expect(needsSync(entry, '2026-06-02T00:00:00Z')).toBe(true);
});
test('findRemoved: uuid in state but absent now => returned', () => {
  const state = emptyState();
  state.pages['uuid-a'] = entry;
  state.pages['uuid-b'] = entry;
  expect(findRemoved(state, new Set(['uuid-a']))).toEqual(['uuid-b']);
});
