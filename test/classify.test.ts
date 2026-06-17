import { expect, test } from 'vitest';
import { classify } from '../src/classify.js';
import type { DiscoveredItem } from '../src/types.js';

const base: DiscoveredItem = {
  uuid: 'u', title: 'T', url: 'https://n', resultType: 'page', inBacklogDb: false, lastEdited: 'x',
};

test('database result => db-index, not canonical', () => {
  expect(classify({ ...base, resultType: 'database', title: 'FE Tasks — PRD 1' }))
    .toEqual({ kind: 'db-index', canonical: false });
});
test('archived/experiment title => archived', () => {
  expect(classify({ ...base, title: '[Archived][Experiment Codex] PRD 2', inBacklogDb: true }))
    .toEqual({ kind: 'archived', canonical: false });
});
test('in backlog db => canonical-prd', () => {
  expect(classify({ ...base, title: 'PRD 2: Client Management', inBacklogDb: true }))
    .toEqual({ kind: 'canonical-prd', canonical: true });
});
test('outside db, not archived => satellite', () => {
  expect(classify({ ...base, title: 'Feedback for PRD 1' }))
    .toEqual({ kind: 'satellite', canonical: false });
});
