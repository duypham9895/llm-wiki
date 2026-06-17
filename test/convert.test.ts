import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeEscapes, resolveNotionLinks, buildSyncMeta } from '../src/convert.js';
import type { DiscoveredItem } from '../src/types.js';

test('normalizeEscapes unescapes Notion bracket artifacts', () => {
  expect(normalizeEscapes('\\[US-01\\] flow')).toBe('[US-01] flow');
});

test('resolveNotionLinks: synced target => wikilink, unsynced => plain link', () => {
  const md = 'See [[notion:aaaa|PRD 1]] and [[notion:bbbb|Tech Doc]].';
  const out = resolveNotionLinks(md, {
    handleByUuid: new Map([['aaaa', 'EP-815-prd-1']]),
    urlByUuid: new Map([['bbbb', 'https://app.notion.com/p/bbbb']]),
  });
  expect(out).toBe('See [[EP-815-prd-1]] and [Tech Doc](https://app.notion.com/p/bbbb).');
});

test('buildSyncMeta maps real Notion properties', () => {
  const props = JSON.parse(readFileSync('test/fixtures/prd-properties.json', 'utf8'));
  const item: DiscoveredItem = {
    uuid: '33d44805-d442-817c-8de7-cb19fcea1d83',
    title: 'PRD 2: Client Management',
    url: 'https://app.notion.com/p/33d44805d442817c8de7cb19fcea1d83',
    resultType: 'page', inBacklogDb: true, lastEdited: '2026-06-17T07:20:38Z', properties: props,
  };
  const meta = buildSyncMeta(item, {
    kind: 'canonical-prd', canonical: true,
    userNames: { 'user-1': 'Duy Pham' }, handleByUuid: new Map(),
    dependsOnUuids: [], trdRefs: [], syncedAt: '2026-06-17T09:00:00Z',
  });
  expect(meta.id).toBe('EP-827');
  expect(meta.status).toBe('Requirement in Progress');
  expect(meta.platform).toEqual(['AI Agent']);
  expect(meta.short_summary).toBe('Full client lifecycle');
  expect(meta.product_pic).toEqual(['Duy Pham']);
  expect(meta.revenue_impact_usd_mo).toBeNull();
});
