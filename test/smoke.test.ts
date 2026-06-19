import { expect, test } from 'vitest';
import type { SyncMeta } from '../src/types.js';

test('types module loads and SyncMeta shape is usable', () => {
  const m: Partial<SyncMeta> = { id: 'EP-1', canonical: true };
  expect(m.id).toBe('EP-1');
});
