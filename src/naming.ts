import type { PrdKind } from './types.js';

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function filenameStem(args: { kind: PrdKind; id: string | null; title: string; uuid: string }): string {
  const slug = slugify(args.title) || 'untitled';
  if (args.id && args.kind === 'canonical-prd') return `${args.id}-${slug}`;
  const short = args.uuid.replace(/-/g, '').slice(0, 8);
  return `${slug}-${short}`;
}
