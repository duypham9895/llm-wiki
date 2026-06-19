import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type { SyncMeta } from './types.js';
import { parseExisting, composeFile } from './frontmatter.js';

export interface FsLike {
  readFile: (p: string, enc?: any) => Promise<string>;
  writeFile: (p: string, d: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
  mkdir: (p: string, opts?: any) => Promise<unknown>;
  unlink: (p: string) => Promise<void>;
}

const defaultFs: FsLike = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  writeFile: (p, d) => nodeFs.writeFile(p, d, 'utf8'),
  rename: (a, b) => nodeFs.rename(a, b),
  mkdir: (p, o) => nodeFs.mkdir(p, o),
  unlink: (p) => nodeFs.unlink(p),
};

export async function writeMarkdown(opts: {
  dir: string; stem: string; sync: SyncMeta; body: string; fs?: FsLike;
}): Promise<string | null> {
  const fs = opts.fs ?? defaultFs;
  const filename = `${opts.stem}.md`;
  const path = join(opts.dir, filename);
  let llmRaw: string | null = null;
  try {
    const existing = await fs.readFile(path);
    const parsed = parseExisting(existing);
    if (parsed.parseError) {
      // Spec §7: the file EXISTS but its frontmatter/llm block could not be parsed.
      // Fail safe — do NOT overwrite (that would silently destroy B's enrichment).
      // Log and skip; the caller must treat a null return as "skipped".
      console.error(
        `[writer] SKIP ${path}: existing frontmatter is unparseable — not overwriting to preserve the llm block (spec §7).`,
      );
      return null;
    }
    llmRaw = parsed.llmRaw;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err; // never silently swallow real read errors
    // ENOENT = file does not exist = first write = fine (scaffold a fresh llm block).
  }
  await fs.mkdir(opts.dir, { recursive: true });
  const content = composeFile(opts.sync, llmRaw, opts.body);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, path);
  return filename;
}

export async function archiveFile(opts: { dir: string; filename: string; fs?: FsLike }): Promise<void> {
  const fs = opts.fs ?? defaultFs;
  const src = join(opts.dir, opts.filename);
  const archiveDir = join(opts.dir, '_Archive');
  let content: string;
  try { content = await fs.readFile(src); } catch (err: any) { if (err.code === 'ENOENT') return; throw err; }
  const updated = content.replace(/removed_from_notion: false/, 'removed_from_notion: true');
  await fs.mkdir(archiveDir, { recursive: true });
  const tmp = join(archiveDir, `${opts.filename}.tmp`);
  await fs.writeFile(tmp, updated);
  await fs.rename(tmp, join(archiveDir, opts.filename));
  await fs.unlink(src);
}
