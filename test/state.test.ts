import { expect, test } from 'vitest';
import { emptyState, needsSync, findRemoved, saveState, loadState } from '../src/state.js';
import type { StateEntry } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

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

test('saveState/loadState: round-trip persists and retrieves state', async () => {
  const testPath = join(tmpdir(), 'state-roundtrip-test.json');
  try {
    const state = emptyState();
    const testUuid = 'test-uuid-1';
    state.pages[testUuid] = entry;

    await saveState(testPath, state);
    const loaded = await loadState(testPath);

    expect(loaded.pages[testUuid]).toEqual(entry);
    expect(loaded.users).toEqual({});
  } finally {
    rmSync(testPath, { force: true });
  }
});

test('loadState: missing file returns empty state', async () => {
  const testPath = join(tmpdir(), 'state-nonexistent-test.json');
  const loaded = await loadState(testPath);

  expect(loaded).toEqual(emptyState());
  expect(loaded.pages).toEqual({});
  expect(loaded.users).toEqual({});
});
