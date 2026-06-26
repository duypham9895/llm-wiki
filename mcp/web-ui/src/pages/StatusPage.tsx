import { useQuery } from '@tanstack/react-query';
import { formatDistanceStrict } from 'date-fns';
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, XCircle } from 'lucide-react';

import { apiFetch } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { RelativeTime } from '../components/RelativeTime';
import { StatCard } from '../components/StatCard';
import { StatusDot } from '../components/StatusDot';

type StageCounts = {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

type PipelineStage = {
  ok?: boolean;
  started_at?: string;
  finished_at?: string;
  counts?: StageCounts;
  error_sample?: string;
  [key: string]: unknown;
};

type PipelineStatus = {
  run_id: string | null;
  stages: Record<string, PipelineStage>;
  halted: boolean;
  halt_reason: string | null;
  halted_at: string | null;
  halted_at_iso?: string | null;
};

type CoverageStatus = {
  total: number;
  enriched: number;
  unenriched: number;
};

type HistoryRun = {
  run_id: string;
  ok: boolean;
  stage_count: number;
  started_at?: string | null;
  finished_at?: string | null;
};

type HistoryResponse = {
  runs: HistoryRun[];
};

const HISTORY_LIMIT = 8;

function statusLabel(stage: PipelineStage): string {
  if (stage.ok === true) return 'OK';
  if (stage.ok === false) return 'Failed';
  if (stage.started_at && !stage.finished_at) return 'Running';
  return 'Unknown';
}

function stageIcon(stage: PipelineStage) {
  if (stage.ok === true) return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />;
  if (stage.ok === false) return <XCircle className="size-4 text-destructive" />;
  if (stage.started_at && !stage.finished_at) {
    return <Loader2 className="size-4 animate-spin text-sky-500" />;
  }
  return <MinusCircle className="size-4 text-muted-foreground" />;
}

function formatDuration(start: string, end: string): string | null {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  try {
    return formatDistanceStrict(a, b);
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 0 ? line : text;
}

function truncateRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function readIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : value;
}

function historyLabel(run: HistoryRun): string {
  const parts: string[] = [run.run_id];
  parts.push(`${run.stage_count} ${run.stage_count === 1 ? 'stage' : 'stages'}`);
  parts.push(run.ok ? 'OK' : 'Failed');
  return parts.join(' · ');
}

export function StatusPage() {
  const pipelineQuery = useQuery({
    queryKey: ['pipeline'],
    queryFn: ({ signal }) => apiFetch<PipelineStatus>('/status/pipeline', { signal }),
    refetchInterval: 30_000,
  });
  const coverageQuery = useQuery({
    queryKey: ['coverage'],
    queryFn: ({ signal }) => apiFetch<CoverageStatus>('/status/coverage', { signal }),
    refetchInterval: 60_000,
  });
  const historyQuery = useQuery({
    queryKey: ['history'],
    queryFn: ({ signal }) =>
      apiFetch<HistoryResponse>(`/status/history?limit=${HISTORY_LIMIT}`, { signal }),
    refetchInterval: 60_000,
  });

  const isLoading = pipelineQuery.isLoading || coverageQuery.isLoading || historyQuery.isLoading;
  const hasBlockingError = pipelineQuery.isError || coverageQuery.isError;
  const pipeline = pipelineQuery.data;
  const coverage = coverageQuery.data;
  const stages = Object.entries(pipeline?.stages ?? {});
  const historyRuns = Array.isArray(historyQuery.data?.runs) ? historyQuery.data.runs : [];

  // Resolve a wall-clock timestamp for the halt banner. The backend currently sends a stage
  // NAME in `halted_at` (legacy field shape); fall back to the matching history row's
  // finished_at when no ISO time is provided.
  const haltedAtIso =
    (pipeline && (readIso(pipeline.halted_at_iso) ?? readIso(pipeline.halted_at))) || null;
  const haltedAtFallback = (() => {
    if (haltedAtIso || !pipeline?.halted) return null;
    const match = pipeline.run_id
      ? historyRuns.find((r) => r.run_id === pipeline.run_id)
      : undefined;
    const latest = match ?? historyRuns[0];
    return latest?.finished_at ?? null;
  })();

  return (
    <section className="space-y-6">
      <PageHeader
        title="Status"
        description="Pipeline health, corpus coverage, and recent orchestrator runs."
      />

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading status.
        </p>
      ) : null}

      {hasBlockingError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Could not load status.
        </p>
      ) : null}

      {pipeline?.halted === true ? (
        <div
          aria-label="Pipeline halted"
          className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive shadow-sm"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" />
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Pipeline halted</h2>
              <p className="text-sm">{pipeline.halt_reason ?? 'No halt reason was reported.'}</p>
              {pipeline.halted_at ? <p className="text-sm">Halted at stage: {pipeline.halted_at}</p> : null}
              {haltedAtIso || haltedAtFallback ? (
                <p className="text-sm">
                  since <RelativeTime date={(haltedAtIso ?? haltedAtFallback) as string} />
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {coverage ? (
        <article className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Coverage</p>
          <h2 className="mt-1 text-xl font-semibold">
            {coverage.enriched} / {coverage.total} enriched
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{coverage.unenriched} not yet processed.</p>
          <CoverageStatGrid coverage={coverage} />
        </article>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <section className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Last run</p>
              <h2 className="text-lg font-semibold">Pipeline stages</h2>
            </div>
            {pipeline?.run_id ? (
              <span className="rounded-full border px-2 py-0.5 font-mono text-xs font-medium text-muted-foreground">
                {truncateRunId(pipeline.run_id)}
              </span>
            ) : null}
          </div>

          {stages.length > 0 ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {stages.map(([name, stage]) => (
                <StageCard key={name} name={name} stage={stage} />
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No pipeline run has been recorded.
            </p>
          )}
        </section>

        <aside className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <h2 className="text-sm font-semibold">History</h2>
          {historyRuns.length > 0 ? (
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              {historyRuns.map((run) => (
                <HistoryRow key={run.run_id} run={run} />
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">No recent runs.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

function StageCard({ name, stage }: { name: string; stage: PipelineStage }) {
  const startedAt = readIso(stage.started_at);
  const finishedAt = readIso(stage.finished_at);
  const duration = startedAt && finishedAt ? formatDuration(startedAt, finishedAt) : null;
  const errorSample = typeof stage.error_sample === 'string' ? stage.error_sample : null;
  const counts = stage.counts;
  const isRunning = !!startedAt && !finishedAt;

  return (
    <article className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">{name}</h3>
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          {stageIcon(stage)}
          {statusLabel(stage)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {counts ? (
          <span>
            synced {counts.succeeded} · skipped {counts.skipped} · archived 0 · errors {counts.failed}
          </span>
        ) : null}
        {duration ? <span>· took {duration}</span> : null}
        {isRunning && startedAt ? (
          <span>
            · Started <RelativeTime date={startedAt} refreshMs={5_000} />
          </span>
        ) : null}
      </div>
      {errorSample ? (
        <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {firstLine(errorSample)}
        </p>
      ) : null}
    </article>
  );
}

function CoverageStatGrid({ coverage }: { coverage: CoverageStatus }) {
  const pct = coverage.total > 0 ? Math.round((coverage.enriched / coverage.total) * 100) : 0;
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-3">
      <StatCard
        label="Enriched"
        value={coverage.enriched}
        delta={{
          value: `${pct}%`,
          intent: pct > 0 ? 'success' : 'neutral',
          direction: pct > 0 ? 'up' : 'down',
        }}
        hint={`of ${coverage.total} PRDs`}
      />
      <StatCard label="Total" value={coverage.total} hint="in the vault" />
      <StatCard
        label="Pending"
        value={coverage.unenriched}
        delta={
          coverage.unenriched > 0
            ? { value: `${coverage.unenriched}`, intent: 'warning', direction: 'down' }
            : { value: '0', intent: 'success', direction: 'up' }
        }
        hint={coverage.unenriched > 0 ? 'awaiting enrichment' : 'all caught up'}
      />
    </div>
  );
}

function HistoryRow({ run }: { run: HistoryRun }) {
  const startedAt = readIso(run.started_at);
  const finishedAt = readIso(run.finished_at);
  const duration = startedAt && finishedAt ? formatDuration(startedAt, finishedAt) : null;
  return (
    <li className="rounded-md border px-3 py-2">
      <div className="flex items-center gap-2">
        <StatusDot status={run.ok ? 'ok' : 'error'} label={run.ok ? 'OK' : 'Failed'} />
        <span className="font-mono text-xs">{truncateRunId(run.run_id)}</span>
        {duration ? <span className="text-xs text-muted-foreground">took {duration}</span> : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {run.stage_count} {run.stage_count === 1 ? 'stage' : 'stages'}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{historyLabel(run)}</p>
    </li>
  );
}
