import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, FileSearch } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusDot } from '@/components/StatusDot';
import { RelativeTime } from '@/components/RelativeTime';
import { MarkdownView, extractHeadings } from '@/components/MarkdownView';
import { apiFetch, ApiError } from '@/lib/api';

interface PrdDetail {
  found: boolean;
  id: string;
  title?: string;
  status?: string;
  tags?: string[];
  source_url?: string;
  body?: string;
  obsidian_link?: string;
  pic?: { email: string; name?: string } | null;
  last_edited?: string;
  synced_at?: string;
}

const STATUS_INTENT: Record<string, 'default' | 'success' | 'warning' | 'info' | 'secondary'> = {
  'In Review': 'warning',
  'In Progress': 'info',
  Done: 'success',
  'Not Started': 'secondary',
  Archived: 'secondary',
};

export function PrdDetailPage() {
  const { id } = useParams<{ id: string }>();
  const query = useQuery<PrdDetail, ApiError>({
    queryKey: ['prd', id],
    queryFn: () => apiFetch<PrdDetail>(`/prd/${id}`),
    enabled: Boolean(id),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  if (query.isLoading) return <PrdDetailSkeleton />;

  if (query.isError || !query.data?.found) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/library">
            <ArrowLeft /> Back to Library
          </Link>
        </Button>
        <EmptyState
          icon={FileSearch}
          title="PRD not found"
          description={
            query.error instanceof ApiError && query.error.status === 404
              ? `We couldn't find a PRD with id "${id}".`
              : 'Something went wrong loading this PRD.'
          }
          action={
            <Button asChild variant="default" size="sm">
              <Link to="/library">Back to Library</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const prd = query.data;
  const headings = extractHeadings(prd.body ?? '');
  const statusVariant = (prd.status && STATUS_INTENT[prd.status]) || 'secondary';

  return (
    <article className="mx-auto max-w-5xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/library">
          <ArrowLeft /> Library
        </Link>
      </Button>

      <PageHeader
        breadcrumb={<span className="font-mono text-xs">{prd.id}</span>}
        title={prd.title ?? prd.id}
        description={prd.tags && prd.tags.length > 0 ? undefined : undefined}
        actions={
          <>
            {prd.source_url && (
              <Button asChild variant="outline" size="sm">
                <a href={prd.source_url} target="_blank" rel="noopener noreferrer">
                  Open in Notion <ExternalLink />
                </a>
              </Button>
            )}
          </>
        }
      />

      {/* Metadata strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        {prd.status && (
          <Badge variant={statusVariant} className="uppercase tracking-wide">
            {prd.status}
          </Badge>
        )}
        {prd.tags?.map((t) => (
          <Badge key={t} variant="outline">
            {t}
          </Badge>
        ))}
        <span className="ml-auto flex items-center gap-3">
          {prd.pic && (
            <span className="flex items-center gap-1.5">
              <StatusDot status="ok" /> {prd.pic.name ?? prd.pic.email}
            </span>
          )}
          {prd.synced_at && (
            <span>
              Synced <RelativeTime date={prd.synced_at} />
            </span>
          )}
        </span>
      </div>

      <Separator />

      {/* Two-column body: TOC + markdown */}
      <div className="grid gap-8 md:grid-cols-[12rem_1fr]">
        <aside className="hidden md:block">
          <nav aria-label="On this page" className="sticky top-20 text-sm">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              On this page
            </p>
            <ul className="space-y-1">
              {headings.map((h) => (
                <li
                  key={h.id}
                  className={h.level === 3 ? 'pl-3' : ''}
                >
                  <a
                    href={`#${h.id}`}
                    className="block truncate text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <div>
          <Tabs defaultValue="body">
            <TabsList>
              <TabsTrigger value="body">Body</TabsTrigger>
              <TabsTrigger value="metadata">Metadata</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="body" className="mt-6">
              {prd.body ? (
                <MarkdownView body={prd.body} idPrefix={prd.id} />
              ) : (
                <EmptyState title="No body content" description="This PRD doesn't have any body text yet." />
              )}
            </TabsContent>
            <TabsContent value="metadata" className="mt-6">
              <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">ID</dt>
                <dd className="font-mono">{prd.id}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{prd.status ?? '—'}</dd>
                <dt className="text-muted-foreground">Tags</dt>
                <dd>{prd.tags?.join(', ') || '—'}</dd>
                <dt className="text-muted-foreground">PIC</dt>
                <dd>{prd.pic?.name ?? prd.pic?.email ?? '—'}</dd>
                <dt className="text-muted-foreground">Last edited</dt>
                <dd>{prd.last_edited ? <RelativeTime date={prd.last_edited} /> : '—'}</dd>
                <dt className="text-muted-foreground">Last synced</dt>
                <dd>{prd.synced_at ? <RelativeTime date={prd.synced_at} /> : '—'}</dd>
                <dt className="text-muted-foreground">Source</dt>
                <dd>
                  {prd.source_url ? (
                    <a
                      href={prd.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Notion <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
              </dl>
            </TabsContent>
            <TabsContent value="history" className="mt-6">
              <EmptyState
                title="No sync history yet"
                description="Once this PRD has been touched by sync runs, you'll see them here."
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </article>
  );
}

function PrdDetailSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-10 w-2/3" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="grid gap-8 md:grid-cols-[12rem_1fr]">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-4/6" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-10/12" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}
