import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Loader2, Search, X } from 'lucide-react';

import { apiFetch } from '../lib/api';

type LibraryItem = {
  id: string;
  title: string;
  status: string;
  tags: string[];
  summary: string;
  source_url: string;
};

type LibraryResponse = {
  results: LibraryItem[];
  next_cursor: string | null;
};

type PrdDetail = {
  found: boolean;
  id: string;
  title: string;
  status: string;
  tags: string[];
  source_url: string;
  obsidian_link: string;
  body: string;
};

const PAGE_SIZE = 12;

function buildLibraryPath(status: string, tag: string, cursor: string | null) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (status) params.set('status', status);
  if (tag) params.set('tag', tag);
  if (cursor) params.set('cursor', cursor);
  return `/prd/library?${params.toString()}`;
}

export function LibraryPage() {
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filters = useMemo(() => ({ status, tag }), [status, tag]);
  const libraryQuery = useQuery({
    queryKey: ['library', filters, cursor],
    queryFn: ({ signal }) => apiFetch<LibraryResponse>(buildLibraryPath(status, tag, cursor), { signal }),
  });

  useEffect(() => {
    setCursor(null);
    setItems([]);
  }, [status, tag]);

  useEffect(() => {
    if (!libraryQuery.data) return;

    setItems((current) => {
      if (!cursor) return libraryQuery.data.results;

      const seen = new Set(current.map((item) => item.id));
      const nextItems = libraryQuery.data.results.filter((item) => !seen.has(item.id));
      return [...current, ...nextItems];
    });
  }, [cursor, libraryQuery.data]);

  const detailQuery = useQuery({
    queryKey: ['prd', selectedId],
    queryFn: ({ signal }) => apiFetch<PrdDetail>(`/prd/${encodeURIComponent(selectedId ?? '')}`, { signal }),
    enabled: selectedId !== null,
  });

  const isFirstLoad = libraryQuery.isLoading && items.length === 0;
  const isEmpty = libraryQuery.isSuccess && !libraryQuery.isFetching && items.length === 0;
  const nextCursor = libraryQuery.data?.next_cursor ?? null;

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">PRD library</p>
          <h1 className="text-2xl font-semibold tracking-normal">Library</h1>
        </div>
        <div className="grid gap-3 sm:grid-cols-[10rem_14rem]">
          <label className="grid gap-1 text-sm font-medium">
            Status
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Tag
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <input
                className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm"
                value={tag}
                onChange={(event) => setTag(event.target.value)}
                placeholder="Filter by tag"
              />
            </div>
          </label>
        </div>
      </div>

      {libraryQuery.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Could not load PRDs.
        </p>
      ) : null}

      {isFirstLoad ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading PRDs.
        </p>
      ) : null}

      {isEmpty ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h2 className="text-lg font-semibold">No PRDs found</h2>
          <p className="mt-2 text-sm text-muted-foreground">Try clearing filters or searching a broader tag.</p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <article key={item.id} className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <button
                  className="text-left text-lg font-semibold hover:underline"
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                >
                  {item.title}
                </button>
                <span className="rounded-full border px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                  {item.status}
                </span>
              </div>
              <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">{item.summary}</p>
              {item.tags.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {item.tags.map((itemTag) => (
                    <span key={itemTag} className="rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground">
                      {itemTag}
                    </span>
                  ))}
                </div>
              ) : null}
              {item.source_url ? (
                <a
                  className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  href={item.source_url}
                  rel="noreferrer"
                  target="_blank"
                >
                  Source <ExternalLink className="size-3.5" />
                </a>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      {nextCursor ? (
        <button
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={libraryQuery.isFetching}
          type="button"
          onClick={() => setCursor(nextCursor)}
        >
          {libraryQuery.isFetching ? 'Loading more' : 'Load more'}
        </button>
      ) : null}

      {selectedId ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4" role="presentation">
          <div
            aria-labelledby="prd-reader-title"
            aria-modal="true"
            className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-lg border bg-background p-6 shadow-lg"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">PRD reader</p>
                <h2 id="prd-reader-title" className="text-xl font-semibold">{detailQuery.data?.title ?? 'Loading PRD'}</h2>
              </div>
              <button
                aria-label="Close PRD reader"
                className="rounded-md p-2 hover:bg-accent"
                type="button"
                onClick={() => setSelectedId(null)}
              >
                <X className="size-4" />
              </button>
            </div>

            {detailQuery.isLoading ? <p className="mt-6 text-sm text-muted-foreground">Loading PRD body.</p> : null}
            {detailQuery.isError ? <p className="mt-6 text-sm text-destructive">Could not load this PRD.</p> : null}
            {detailQuery.data ? (
              <div className="mt-6 space-y-4">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                    {detailQuery.data.status}
                  </span>
                  {detailQuery.data.tags.map((itemTag) => (
                    <span key={itemTag} className="rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground">
                      {itemTag}
                    </span>
                  ))}
                </div>
                <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 text-sm leading-6 text-muted-foreground">
                  {detailQuery.data.body}
                </pre>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
