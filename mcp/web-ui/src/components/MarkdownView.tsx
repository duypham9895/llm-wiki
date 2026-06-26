import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { visit, SKIP } from 'unist-util-visit';
import type { Plugin } from 'unified';
import type { Root, Text, Link, PhrasingContent, Parent } from 'mdast';
import { cn } from '@/lib/utils';

export interface MarkdownViewProps {
  body: string;
  className?: string;
  /** Optional id-prefix for heading anchors (avoids collisions when multiple readers mount). */
  idPrefix?: string;
}

const WIKILINK_RE = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

/**
 * Remark plugin: transforms `[[EP-468]]` and `[[EP-468|Label]]` into markdown link nodes.
 *   [[EP-468]]         -> [EP-468](/library/EP-468)
 *   [[EP-468|Label]]   -> [Label](/library/EP-468)
 * The id may contain any non-`]`/non-newline/non-`|` chars (handles `notion:uuid|page` and EP-style handles alike).
 * Existence is NOT validated here — let the destination 404.
 */
export const remarkWikilinks: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || typeof index !== 'number') return;
      const value = node.value;
      WIKILINK_RE.lastIndex = 0;
      if (!WIKILINK_RE.test(value)) return;
      WIKILINK_RE.lastIndex = 0;

      const newChildren: PhrasingContent[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = WIKILINK_RE.exec(value)) !== null) {
        const [full, rawId, rawLabel] = match;
        const id = rawId.trim();
        if (!id) continue;
        const label = (rawLabel ?? rawId).trim();
        if (match.index > lastIndex) {
          newChildren.push({ type: 'text', value: value.slice(lastIndex, match.index) });
        }
        const link: Link = {
          type: 'link',
          url: `/library/${encodeURIComponent(id)}`,
          title: null,
          children: [{ type: 'text', value: label }],
        };
        newChildren.push(link);
        lastIndex = match.index + full.length;
      }
      if (lastIndex < value.length) {
        newChildren.push({ type: 'text', value: value.slice(lastIndex) });
      }
      parent.children.splice(index, 1, ...newChildren);
      return [SKIP, index + newChildren.length];
    });
  };
};

/**
 * Renders PRD body markdown with shadcn prose styles.
 * GFM: tables, task lists, strikethrough, autolinks.
 * rehype-raw: pass-through inline HTML (used sparingly by the sync CLI).
 * remarkWikilinks: [[EP-468]] / [[EP-468|Label]] -> library links.
 */
export function MarkdownView({ body, className, idPrefix }: MarkdownViewProps) {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none',
        'prose-headings:tracking-tight prose-headings:font-semibold',
        'prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-h4:text-base',
        'prose-h2:mt-8 prose-h2:border-b prose-h2:pb-1 prose-h2:scroll-mt-20',
        'prose-h3:mt-6 prose-h3:scroll-mt-20',
        'prose-p:leading-relaxed',
        'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
        'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.875em] prose-code:before:hidden prose-code:after:hidden',
        'prose-pre:bg-muted prose-pre:border',
        'prose-table:border prose-th:border prose-td:border',
        'prose-blockquote:border-l-primary prose-blockquote:not-italic',
        'prose-img:rounded-md prose-img:border',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikilinks]}
        rehypePlugins={[rehypeRaw]}
        components={{
          h1: ({ id, ...rest }) => <h1 id={prefixId(id, idPrefix)} {...rest} />,
          h2: ({ id, ...rest }) => <h2 id={prefixId(id, idPrefix)} {...rest} />,
          h3: ({ id, ...rest }) => <h3 id={prefixId(id, idPrefix)} {...rest} />,
          h4: ({ id, ...rest }) => <h4 id={prefixId(id, idPrefix)} {...rest} />,
          a: ({ href, children, ...rest }) => {
            const isExternal = href?.startsWith('http');
            if (isExternal) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                  {children}
                </a>
              );
            }
            return (
              <a href={href} {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function prefixId(id: string | undefined, prefix: string | undefined): string | undefined {
  if (!id) return undefined;
  return prefix ? `${prefix}-${id}` : id;
}

/** Extract h2/h3 headings from a markdown body for TOC rendering. */
export interface TocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

export function extractHeadings(body: string, idPrefix?: string): TocHeading[] {
  const headings: TocHeading[] = [];
  const lines = body.split('\n');
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(##|###)\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const level = (m[1].length as 2 | 3);
    const text = m[2].trim();
    const id = slugify(text, idPrefix);
    headings.push({ id, text, level });
  }
  return headings;
}

function slugify(text: string, prefix?: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return prefix ? `${prefix}-${base}` : base;
}
