import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, FileSearch } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
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
    <article className="mx-auto max-w-4xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/library">
          <ArrowLeft /> Library
        </Link>
      </Button>

      <PageHeader
        title={prd.title ?? prd.id}
        actions={
          prd.source_url && (
            <Button asChild variant="outline" size="sm">
              <a href={prd.source_url} target="_blank" rel="noopener noreferrer">
                Open in Notion <ExternalLink />
              </a>
            </Button>
          )
        }
      />

      {/* Compact status + tags row */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {prd.status && (
          <Badge variant={statusVariant}>{prd.status}</Badge>
        )}
        {prd.tags?.slice(0, 5).map((t) => (
          <Badge key={t} variant="outline">{t}</Badge>
        ))}
      </div>

      <Separator />

      {/* Two-column: TOC + markdown */}
      <div className="grid gap-8 md:grid-cols-[10rem_1fr]">
        {headings.length > 0 && (
          <aside className="hidden md:block">
            <nav aria-label="On this page" className="sticky top-20 text-sm">
              <ul className="space-y-1.5">
                {headings.map((h) => (
                  <li key={h.id} className={h.level === 3 ? 'pl-3' : ''}>
                    <a
                      href={`#${h.id}`}
                      className="block truncate text-muted-foreground hover:text-foreground"
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        )}
        <div>
          {prd.body ? (
            <MarkdownView body={prd.body} idPrefix={prd.id} />
          ) : (
            <EmptyState title="No body content" description="This PRD doesn't have any body text yet." />
          )}
          <dl className="mt-12 grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5 border-t pt-6 text-sm text-muted-foreground">
            <dt>ID</dt>
            <dd className="font-mono text-foreground">{prd.id}</dd>
            {prd.pic && (
              <>
                <dt>PIC</dt>
                <dd className="text-foreground">{prd.pic.name ?? prd.pic.email}</dd>
              </>
            )}
            {prd.synced_at && (
              <>
                <dt>Synced</dt>
                <dd className="text-foreground"><RelativeTime date={prd.synced_at} /></dd>
              </>
            )}
            {prd.last_edited && (
              <>
                <dt>Edited</dt>
                <dd className="text-foreground"><RelativeTime date={prd.last_edited} /></dd>
              </>
            )}
          </dl>
        </div>
      </div>
    </article>
  );
}

function PrdDetailSkeleton() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-10 w-2/3" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="grid gap-8 md:grid-cols-[10rem_1fr]">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
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
