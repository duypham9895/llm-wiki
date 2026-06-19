import { expect, test } from 'vitest';
import type { EnrichConfig } from '../../src/enrich/enrich-types.js';

test('enrich types load', () => {
  const c: Partial<EnrichConfig> = { topK: 5, model: 'MiniMax-M2' };
  expect(c.topK).toBe(5);
});
