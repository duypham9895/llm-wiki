import { expect, test } from 'vitest';
import { relatedEqual } from '../../src/enrich/enrich-helpers.js';

// Fix 1: relatedEqual helper — dirty-gating logic
test('relatedEqual: empty arrays are equal', () => {
  expect(relatedEqual([], [])).toBe(true);
});

test('relatedEqual: same elements same order', () => {
  expect(relatedEqual(['[[A]]', '[[B]]'], ['[[A]]', '[[B]]'])).toBe(true);
});

test('relatedEqual: same elements different order → NOT equal', () => {
  expect(relatedEqual(['[[A]]', '[[B]]'], ['[[B]]', '[[A]]'])).toBe(false);
});

test('relatedEqual: different lengths → NOT equal', () => {
  expect(relatedEqual(['[[A]]'], ['[[A]]', '[[B]]'])).toBe(false);
  expect(relatedEqual(['[[A]]', '[[B]]'], ['[[A]]'])).toBe(false);
});

test('relatedEqual: completely different → NOT equal', () => {
  expect(relatedEqual(['[[A]]'], ['[[B]]'])).toBe(false);
});

test('relatedEqual: single element match', () => {
  expect(relatedEqual(['[[EP-001]]'], ['[[EP-001]]'])).toBe(true);
});
