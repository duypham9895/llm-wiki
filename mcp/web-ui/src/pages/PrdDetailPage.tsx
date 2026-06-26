import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, FileSearch, MoreHorizontal } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RelativeTime } from '@/components/RelativeTime';
import { MarkdownView, extractHeadings } from '@/components/MarkdownView';
import { apiFetch, ApiError } from '@/lib/api';
import { recordLocalRecent } from '@/lib/recent';

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

function obsidianUriFor(prdId: string): string {
  // Best-effort Obsidian URI. Encodes the id; vault prefix assumed to be set
  // in the user's Obsidian config (Advanced → Obsidian URI).
  return `obsidian://open?vault=PRD&file=${encodeURIComponent(prdId)}`;
}

export function PrdDetailPage() {
  const { id } = useParams<{ id: string }>();
  const query = useQuery<PrdDetail, ApiError>({
    queryKey: ['prd', id],
    queryFn: () => apiFetch<PrdDetail>(`/prd/${id}`),
    enabled: Boolean(id),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });

  // Record this view in the localStorage cache for the CommandPalette quick-jump.
  React.useEffect(() => {
    if (!id || !query.data?.found) return;
    recordLocalRecent(id, query.data.title ?? '');
  }, [id, query.data?.found, query.data?.title]);

  const enrichMutation = useMutation({
    mutationFn: () => apiFetch<{ status: string; id: string; prd_id: string }>(
      `/prd/${encodeURIComponent(id ?? '')}/enrich`,
      { method: 'POST' },
    ),
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
  const obsidianLink = prd.obsidian_link ?? obsidianUriFor(prd.id);

  async function copyToClipboard(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  function copyId() {
    void copyToClipboard(prd.id, 'Copied PRD ID');
  }

  function copyObsidianLink() {
    void copyToClipboard(obsidianLink, 'Copied Obsidian link');
  }

  function triggerEnrich() {
    enrichMutation.mutate(undefined, {
      onSuccess: () => toast.success('Enrichment queued'),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : 'Could not queue enrichment'),
    });
  }

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
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={copyId} data-testid="action-copy-id">
                  Copy ID
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={copyObsidianLink} data-testid="action-copy-obsidian">
                  Copy Obsidian link
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {prd.source_url && (
                  <DropdownMenuItem asChild>
                    <a
                      href={prd.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="action-open-notion"
                    >
                      Open in Notion <ExternalLink />
                    </a>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={triggerEnrich}
                  disabled={enrichMutation.isPending}
                  data-testid="action-reenrich"
                >
                  Re-enrich
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {prd.source_url && (
              <Button asChild variant="outline" size="sm">
                <a href={prd.source_url} target="_blank" rel="noopener noreferrer">
                  Open in Notion <ExternalLink />
                </a>
              </Button>
            )}
          </div>
        }
      />

      {/* Compact status + tags row */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {prd.status && <Badge variant={statusVariant}>{prd.status}</Badge>}
        {prd.tags?.slice(0, 5).map((t) => (
          <Badge key={t} variant="outline">
            {t}
          </Badge>
        ))}
      </div>

      <Separator />

      <Tabs defaultValue="body" className="w-full">
        <TabsList aria-label="PRD detail views">
          <TabsTrigger value="body">Body</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="body" className="focus-visible:outline-none">
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
            <div data-testid="prd-body">
              {prd.body ? (
                <MarkdownView body={prd.body} idPrefix={prd.id} />
              ) : (
                <EmptyState
                  title="No body content"
                  description="This PRD doesn't have any body text yet."
                />
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="metadata" className="focus-visible:outline-none">
          <dl
            data-testid="prd-metadata"
            className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5 border-t pt-6 text-sm text-muted-foreground"
          >
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
                <dd className="text-foreground">
                  <RelativeTime date={prd.synced_at} />
                </dd>
              </>
            )}
            {prd.last_edited && (
              <>
                <dt>Edited</dt>
                <dd className="text-foreground">
                  <RelativeTime date={prd.last_edited} />
                </dd>
              </>
            )}
            {prd.source_url && (
              <>
                <dt>Source</dt>
                <dd className="text-foreground">
                  <a
                    href={prd.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Open in Notion <ExternalLink className="inline h-3 w-3" />
                  </a>
                </dd>
              </>
            )}
            {prd.obsidian_link && (
              <>
                <dt>Obsidian</dt>
                <dd className="break-all font-mono text-foreground">{prd.obsidian_link}</dd>
              </>
            )}
          </dl>
        </TabsContent>

        <TabsContent value="conversations" className="focus-visible:outline-none">
          <div data-testid="prd-conversations">
            <EmptyState
              title="Conversations about this PRD will appear here"
              description="Ask a question about this PRD and the thread will show up here for easy follow-up."
            />
          </div>
        </TabsContent>

        <TabsContent value="history" className="focus-visible:outline-none">
          <div data-testid="prd-history">
            <EmptyState
              title="Sync history coming soon"
              description="We're wiring up per-PRD sync history. For now, the Status page shows recent sync runs across the whole vault."
            />
          </div>
        </TabsContent>
      </Tabs>
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