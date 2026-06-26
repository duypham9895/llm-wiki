import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Library as LibraryIcon, Loader2, Search } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type LibraryItem = {
  id: string;
  title: string;
  status: string;
  tags: string[];
  summary: string;
  source_url: string;
  last_edited?: string;
};

type LibraryResponse = {
  results: LibraryItem[];
  next_cursor: string | null;
};

const PAGE_SIZE = 12;

function buildLibraryPath(status: string, tag: string, cursor: string | null) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (status) params.set('status', status);
  if (tag) params.set('tag', tag);
  if (cursor) params.set('cursor', cursor);
  return `/prd/library?${params.toString()}`;
}

const STATUS_BADGE: Record<string, 'default' | 'success' | 'warning' | 'info' | 'secondary'> = {
  Active: 'info',
  Draft: 'secondary',
  Archived: 'secondary',
  Done: 'success',
  'In Review': 'warning',
  'In Progress': 'info',
  'Not Started': 'secondary',
};

export function LibraryPage() {
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<LibraryItem[]>([]);

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

  const isFirstLoad = libraryQuery.isLoading && items.length === 0;
  const isEmpty = libraryQuery.isSuccess && !libraryQuery.isFetching && items.length === 0;
  const nextCursor = libraryQuery.data?.next_cursor ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Library"
        description="Browse every PRD in the vault. Filter by status or tag."
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid w-44 gap-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="lib-status">
            Status
          </label>
          <Select value={status || 'all'} onValueChange={(v) => setStatus(v === 'all' ? '' : v)}>
            <SelectTrigger id="lib-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid flex-1 gap-1.5 sm:max-w-xs">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="lib-tag">
            Tag
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              id="lib-tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="Filter by tag…"
              className="pl-8"
            />
          </div>
        </div>
        {(status || tag) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus('');
              setTag('');
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {libraryQuery.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Could not load PRDs.
        </div>
      )}

      {isFirstLoad && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <div className="flex gap-2 pt-2">
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 w-12" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {isEmpty && (
        <EmptyState
          icon={LibraryIcon}
          title="No PRDs found"
          description="Try clearing filters or searching a broader tag."
          action={
            status || tag
              ? {
                  label: 'Clear filters',
                  onClick: () => {
                    setStatus('');
                    setTag('');
                  },
                }
              : undefined
          }
        />
      )}

      {items.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <Link
              key={item.id}
              to={`/library/${encodeURIComponent(item.id)}`}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-lg"
            >
              <Card className="h-full transition-colors hover:bg-accent/40">
                <CardContent className="space-y-2 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="line-clamp-2 text-base font-medium leading-tight">
                      {item.title}
                    </h3>
                    <Badge
                      variant={STATUS_BADGE[item.status] ?? 'secondary'}
                      className="shrink-0 capitalize"
                    >
                      {item.status}
                    </Badge>
                  </div>
                  {item.summary && (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{item.summary}</p>
                  )}
                  {item.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {item.tags.slice(0, 3).map((t) => (
                        <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {libraryQuery.isFetching && items.length > 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={libraryQuery.isFetching}
            onClick={() => setCursor(nextCursor)}
          >
            {libraryQuery.isFetching ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
