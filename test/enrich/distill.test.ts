import { expect, test } from 'vitest';
import { distill } from '../../src/enrich/distill.js';

const base = { title: 'PRD X', shortSummary: 'short', status: 'In Development', platform: ['AI Agent'], strategicGoal: ['RISA-NXT'], threshold: 100, sectionHeadChars: 30 };

test('small body passes through whole, with a header block', () => {
  const out = distill({ ...base, threshold: 10000, body: '## Goal\nShip it.\n' });
  expect(out).toContain('Title: PRD X');
  expect(out).toContain('Status: In Development');
  expect(out).toContain('## Goal');
  expect(out).toContain('Ship it.');
});

test('large body is distilled to headings + bounded section heads', () => {
  const big = '## Background\n' + 'x'.repeat(500) + '\n## Goal\n' + 'y'.repeat(500) + '\n';
  const out = distill({ ...base, threshold: 100, sectionHeadChars: 20, body: big });
  expect(out).toContain('## Background');
  expect(out).toContain('## Goal');
  // each section's text is truncated to ~20 chars, so the full 500-char runs are NOT present
  expect(out).not.toContain('x'.repeat(100));
  expect(out).not.toContain('y'.repeat(100));
  expect(out.length).toBeLessThan(big.length);
});

test('large body with no headings still returns the header block and a bounded excerpt', () => {
  const big = 'z'.repeat(500);
  const out = distill({ ...base, threshold: 100, sectionHeadChars: 20, body: big });
  expect(out).toContain('Title: PRD X');
  expect(out.length).toBeLessThan(big.length);
});
