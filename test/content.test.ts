import { expect, test } from 'vitest';
import { hasRealContent } from '../src/content.js';

test('empty / whitespace-only body is not real content', () => {
  expect(hasRealContent('', 300)).toBe(false);
  expect(hasRealContent('   \n\n  \t ', 300)).toBe(false);
});

test('a stub heading alone is below threshold', () => {
  expect(hasRealContent('# Title\n\n', 300)).toBe(false);
});

test('a substantial body is real content', () => {
  const body = '# Background\n\n' + 'This PRD describes the disbursement flow in detail. '.repeat(20);
  expect(hasRealContent(body, 300)).toBe(true);
});

test('counts visible text, not markdown punctuation', () => {
  // 250 pipe/dash table-border chars but little real text → below 300
  const tableNoise = '| --- | --- |\n'.repeat(20);
  expect(hasRealContent(tableNoise, 300)).toBe(false);
});
