import { expect, test } from 'vitest';
import { normalizeTag, normalizeTags } from '../../src/enrich/tags.js';

test('normalizeTag lowercases and kebab-cases', () => {
  expect(normalizeTag('Saudi CRM')).toBe('saudi-crm');
  expect(normalizeTag('  Email_Notifications ')).toBe('email-notifications');
  expect(normalizeTag('AI/Agent')).toBe('ai-agent');
});
test('normalizeTags dedupes case-insensitively and drops empties, preserving order', () => {
  expect(normalizeTags(['CRM', 'crm', 'Saudi', '', '  ', 'saudi'])).toEqual(['crm', 'saudi']);
});
test('normalizeTags strips leading/trailing hyphens from punctuation', () => {
  expect(normalizeTags(['(beta)', '#tag'])).toEqual(['beta', 'tag']);
});
