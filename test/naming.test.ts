import { expect, test } from 'vitest';
import { slugify, filenameStem } from '../src/naming.js';

test('slugify lowercases, strips punctuation, hyphenates', () => {
  expect(slugify('PRD 2: Client Management — RISA Portal')).toBe('prd-2-client-management-risa-portal');
});
test('slugify trims and collapses repeats', () => {
  expect(slugify('  A  &&  B  ')).toBe('a-b');
});
test('canonical stem uses EP id + slug', () => {
  expect(filenameStem({ kind: 'canonical-prd', id: 'EP-827', title: 'Client Management', uuid: '33d44805-d442-817c-8de7-cb19fcea1d83' }))
    .toBe('EP-827-client-management');
});
test('satellite stem uses slug + short uuid', () => {
  expect(filenameStem({ kind: 'satellite', id: null, title: 'Feedback for PRD 1', uuid: '37544805-d442-8079-8cf2-f926bd6bff25' }))
    .toBe('feedback-for-prd-1-37544805');
});
