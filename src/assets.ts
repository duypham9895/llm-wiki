import { join } from 'node:path';

export function extractImageUrls(md: string): string[] {
  const urls: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) urls.push(m[1]);
  return urls;
}

export function localImagePath(attachmentsDir: string, id: string, url: string, index: number): string {
  const clean = url.split('?')[0];
  const ext = (clean.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1] ?? 'png').toLowerCase();
  return join(attachmentsDir, id, `img-${index}.${ext}`);
}

export async function downloadImages(
  md: string,
  opts: {
    id: string; attachmentsDir: string; vaultRelativePrefix: string;
    fetchFn: typeof fetch; writeFileFn: (p: string, d: Buffer) => Promise<void>;
    mkdirFn: (p: string) => Promise<void>;
  },
): Promise<string> {
  const urls = extractImageUrls(md);
  let out = md;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const abs = localImagePath(opts.attachmentsDir, opts.id, url, i);
    const rel = `${opts.vaultRelativePrefix}/${opts.id}/${abs.split('/').pop()}`;
    try {
      const res = await opts.fetchFn(url);
      if (!(res as Response).ok) throw new Error('bad status');
      await opts.mkdirFn(join(opts.attachmentsDir, opts.id));
      const buf = Buffer.from(await (res as Response).arrayBuffer());
      await opts.writeFileFn(abs, buf);
      out = out.replace(`(${url})`, `(${rel})`);
    } catch {
      out = out.replace(`(${url})`, `(${url}) <!-- image download failed -->`);
    }
  }
  return out;
}
