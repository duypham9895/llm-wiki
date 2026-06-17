import { expect, test } from 'vitest';
import { extractImageUrls, localImagePath, downloadImages } from '../src/assets.js';

test('extractImageUrls finds markdown image targets', () => {
  const md = '![a](https://x/img1.png)\ntext\n![b](https://y/img2.jpg?sig=1)';
  expect(extractImageUrls(md)).toEqual(['https://x/img1.png', 'https://y/img2.jpg?sig=1']);
});

test('localImagePath derives extension and namespaced path', () => {
  expect(localImagePath('/v/PRDs/_attachments', 'EP-1', 'https://x/p.png?sig=1', 0))
    .toBe('/v/PRDs/_attachments/EP-1/img-0.png');
});

test('downloadImages rewrites to vault-relative path on success', async () => {
  const md = '![a](https://x/p.png)';
  const writes: string[] = [];
  const out = await downloadImages(md, {
    id: 'EP-1', attachmentsDir: '/v/PRDs/_attachments', vaultRelativePrefix: '_attachments',
    fetchFn: (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) })) as unknown as typeof fetch,
    writeFileFn: async (p) => { writes.push(p); },
    mkdirFn: async () => {},
  });
  expect(out).toBe('![a](_attachments/EP-1/img-0.png)');
  expect(writes).toEqual(['/v/PRDs/_attachments/EP-1/img-0.png']);
});

test('downloadImages leaves marker on failure', async () => {
  const md = '![a](https://x/p.png)';
  const out = await downloadImages(md, {
    id: 'EP-1', attachmentsDir: '/v/PRDs/_attachments', vaultRelativePrefix: '_attachments',
    fetchFn: (async () => ({ ok: false })) as unknown as typeof fetch,
    writeFileFn: async () => {}, mkdirFn: async () => {},
  });
  expect(out).toContain('<!-- image download failed -->');
  expect(out).toContain('https://x/p.png');
});
