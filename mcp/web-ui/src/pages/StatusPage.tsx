import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, XCircle } from 'lucide-react';

import { apiFetch } from '../lib/api';

type PipelineStage = {
  ok?: boolean;
  [key: string]: unknown;
};

type PipelineStatus = {
  run_id: string | null;
  stages: Record<string, PipelineStage>;
  halted: boolean;
  halt_reason: string | null;
  halted_at: string | null;
};

type CoverageStatus = {
  total: number;
  enriched: number;
  unenriched: number;
};

type HistoryResponse = {
  runs: unknown[];
};

type HistoryItem = {
  key: string;
  label: string;
};

const HISTORY_LIMIT = 8;

function statusLabel(stage: PipelineStage) {
  if (stage.ok === true) return 'OK';
  if (stage.ok === false) return 'Failed';
  return 'Unknown';
}

function historyItem(run: unknown, index: number): HistoryItem | null {
  if (!run || typeof run !== 'object') return null;

  const fields = run as Record<string, unknown>;
  const runId = typeof fields.run_id === 'string' ? fields.run_id : null;
  const ok = typeof fields.ok === 'boolean' ? fields.ok : null;
  const stageCount = typeof fields.stage_count === 'number' ? fields.stage_count : null;
  const labelParts: string[] = [];

  if (runId) labelParts.push(runId);
  if (stageCount !== null) labelParts.push(`${stageCount} ${stageCount === 1 ? 'stage' : 'stages'}`);
  if (ok !== null) labelParts.push(ok ? 'OK' : 'Failed');

  if (labelParts.length === 0) return null;
  return { key: runId ?? String(index), label: labelParts.join(' · ') };
}

function stageIcon(stage: PipelineStage) {
  if (stage.ok === true) return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />;
  if (stage.ok === false) return <XCircle className="size-4 text-destructive" />;
  return <MinusCircle className="size-4 text-muted-foreground" />;
}

export function StatusPage() {
  const pipelineQuery = useQuery({
    queryKey: ['pipeline'],
    queryFn: ({ signal }) => apiFetch<PipelineStatus>('/status/pipeline', { signal }),
  });
  const coverageQuery = useQuery({
    queryKey: ['coverage'],
    queryFn: ({ signal }) => apiFetch<CoverageStatus>('/status/coverage', { signal }),
  });
  const historyQuery = useQuery({
    queryKey: ['history'],
    queryFn: ({ signal }) => apiFetch<HistoryResponse>(`/status/history?limit=${HISTORY_LIMIT}`, { signal }),
  });

  const isLoading = pipelineQuery.isLoading || coverageQuery.isLoading || historyQuery.isLoading;
  const hasBlockingError = pipelineQuery.isError || coverageQuery.isError;
  const pipeline = pipelineQuery.data;
  const coverage = coverageQuery.data;
  const stages = Object.entries(pipeline?.stages ?? {});
  const historyRuns = Array.isArray(historyQuery.data?.runs) ? historyQuery.data.runs : [];
  const historyItems = historyRuns.map(historyItem).filter((item): item is HistoryItem => item !== null);

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Pipeline status</p>
        <h1 className="text-2xl font-semibold tracking-normal">Status</h1>
      </div>

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
              <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {pipeline.run_id}
              </span>
            ) : null}
          </div>

          {stages.length > 0 ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {stages.map(([name, stage]) => (
                <article key={name} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-medium">{name}</h3>
                    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                      {stageIcon(stage)}
                      {statusLabel(stage)}
                    </span>
                  </div>
                </article>
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
          {historyItems.length > 0 ? (
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              {historyItems.map((item) => (
                <li key={item.key} className="rounded-md border px-3 py-2">
                  {item.label}
                </li>
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
