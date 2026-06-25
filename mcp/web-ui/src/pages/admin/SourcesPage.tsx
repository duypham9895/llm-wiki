import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Loader2, Plug, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch, ApiError } from '@/lib/api';
import { formatElapsed } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { RelativeTime } from '@/components/RelativeTime';
import { StatusDot } from '@/components/StatusDot';
import { Skeleton } from '@/components/ui/skeleton';

type SourceStatus = 'idle' | 'running' | 'ok' | 'error';
type RunStatus = 'running' | 'ok' | 'error' | 'timeout';

interface RunCounts {
  synced: number;
  skipped: number;
  archived: number;
  errors: number;
}

interface SourceOut {
  id: string;
  kind: string;
  label: string;
  subtitle: string;
  status: SourceStatus;
  last_run_at: string | null;
  last_run_summary: RunCounts | null;
  schedule: string;
}

interface RunOut {
  id: string;
  source_id: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  counts: RunCounts | null;
  error: string | null;
}

const RUN_CONFIRM_COPY =
  'This will write to the vault and re-index Chroma. Continue?';

export function SourcesPage() {
  const queryClient = useQueryClient();
  const [pendingRun, setPendingRun] = React.useState<SourceOut | null>(null);

  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: ({ signal }) => apiFetch<SourceOut[]>('/admin/sources', { signal }),
    refetchInterval: (query) => {
      const data = query.state.data;
      const anyRunning = Array.isArray(data) && data.some((s) => s.status === 'running');
      return anyRunning ? 5_000 : 30_000;
    },
  });

  const runMutation = useMutation({
    mutationFn: (sourceId: string) =>
      apiFetch<RunOut>(`/admin/sources/${encodeURIComponent(sourceId)}/run`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      toast.success(`Sync started for ${data.source_id}`);
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
      void queryClient.invalidateQueries({ queryKey: ['source-runs'] });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Could not start sync.';
      toast.error(message);
    },
    onSettled: () => {
      setPendingRun(null);
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Sources"
        description="Connect external systems that feed your PRD vault."
      />

      {sources.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : sources.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load sources.
        </p>
      ) : (sources.data ?? []).length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No sources configured"
          description="Connect a source to start pulling PRDs into the vault."
        />
      ) : (
        (sources.data ?? []).map((src) => (
          <SourceCard
            key={src.id}
            source={src}
            onRequestRun={() => setPendingRun(src)}
            disabled={runMutation.isPending}
          />
        ))
      )}

      <Dialog
        open={pendingRun !== null}
        onOpenChange={(open) => {
          if (!open && !runMutation.isPending) setPendingRun(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run sync now</DialogTitle>
            <DialogDescription>{RUN_CONFIRM_COPY}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={runMutation.isPending}
              onClick={() => setPendingRun(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={runMutation.isPending}
              onClick={() => pendingRun && runMutation.mutate(pendingRun.id)}
            >
              {runMutation.isPending ? (
                <>
                  <Loader2 className="animate-spin" /> Starting…
                </>
              ) : (
                'Run sync'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface SourceCardProps {
  source: SourceOut;
  onRequestRun: () => void;
  disabled: boolean;
}

function SourceCard({ source, onRequestRun, disabled }: SourceCardProps) {
  const runs = useQuery({
    queryKey: ['source-runs', source.id],
    queryFn: ({ signal }) =>
      apiFetch<RunOut[]>(`/admin/sources/${encodeURIComponent(source.id)}/runs?limit=10`, {
        signal,
      }),
    refetchInterval: source.status === 'running' ? 5_000 : 30_000,
  });

  const isRunning = source.status === 'running';
  const runRow = runs.data?.[0] ?? null;
  const elapsedSeconds = useElapsedSeconds(isRunning ? runRow?.started_at ?? null : null);
  const recentRuns = (runs.data ?? []).slice(0, 5);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-muted-foreground" />
            {source.label}
          </CardTitle>
          <CardDescription>{source.subtitle}</CardDescription>
        </div>
        {isRunning ? (
          <RunningIndicator startedAt={runRow?.started_at} elapsedSeconds={elapsedSeconds} />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={onRequestRun}
          >
            <RefreshCw /> Run now
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <StatusRow source={source} />
        <RecentRuns runs={recentRuns} loading={runs.isLoading} />
      </CardContent>
    </Card>
  );
}

function StatusRow({ source }: { source: SourceOut }) {
  const summary = source.last_run_summary;
  const last = source.last_run_at ? <RelativeTime date={source.last_run_at} /> : 'never';
  const statusLabel = (() => {
    if (source.status === 'running') return 'Running';
    if (source.status === 'idle') return 'Never run';
    return source.status === 'ok' ? 'OK' : 'Error';
  })();

  return (
    <div className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot status={source.status} label={statusLabel} />
        <span className="text-muted-foreground">Last run:</span>
        <span>{last}</span>
        {summary ? (
          <span className="text-muted-foreground">
            · synced {summary.synced} · skipped {summary.skipped} · archived {summary.archived}
            · errors {summary.errors}
          </span>
        ) : null}
        <span className="text-muted-foreground">· Schedule: {source.schedule}</span>
      </div>
    </div>
  );
}

function RecentRuns({ runs, loading }: { runs: RunOut[]; loading: boolean }) {
  if (loading) {
    return <Skeleton className="h-16 w-full" />;
  }
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">No runs yet.</p>;
  }
  return (
    <ul className="divide-y rounded-md border text-sm" data-testid="recent-runs">
      {runs.map((run) => {
        const c = run.counts;
        const summary = c
          ? `${c.synced}/${c.skipped}/${c.archived}/${c.errors}`
          : '—';
        return (
          <li key={run.id} className="flex items-center gap-3 px-3 py-2">
            <StatusDot status={run.status === 'ok' ? 'ok' : run.status === 'running' ? 'running' : 'error'} />
            <RelativeTime date={run.started_at} />
            <span className="text-muted-foreground">{run.status}</span>
            <span className="ml-auto font-mono text-xs text-muted-foreground">{summary}</span>
          </li>
        );
      })}
    </ul>
  );
}

function RunningIndicator({
  startedAt,
  elapsedSeconds,
}: {
  startedAt: string | null | undefined;
  elapsedSeconds: number;
}) {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground"
      aria-live="polite"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {startedAt ? (
        <span>
          Running <RelativeTime date={startedAt} /> · {formatElapsed(elapsedSeconds)}
        </span>
      ) : (
        <span>Starting…</span>
      )}
    </div>
  );
}

function useElapsedSeconds(startedAt: string | null): number {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(force, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}
