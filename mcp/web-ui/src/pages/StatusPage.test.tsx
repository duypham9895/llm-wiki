import { screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../test/util';
import { StatusPage } from './StatusPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

type TestPipeline = {
  run_id: string | null;
  stages: Record<string, { ok?: boolean }>;
  halted: boolean;
  halt_reason: string | null;
  halted_at: string | null;
};

type TestCoverage = {
  total: number;
  enriched: number;
  unenriched: number;
};

type TestHistory = {
  runs: Array<{ run_id?: string; ok?: boolean; stage_count?: number }>;
};

function installStatusHandlers({
  pipeline = {
    run_id: 'r1',
    stages: { sync: { ok: true }, enrich: { ok: true } },
    halted: false,
    halt_reason: null,
    halted_at: null,
  },
  coverage = { total: 287, enriched: 200, unenriched: 87 },
  history = {
    runs: [
      { run_id: 'r1', ok: true, stage_count: 3 },
      { run_id: 'r2', ok: false, stage_count: 2 },
    ],
  },
}: { pipeline?: TestPipeline; coverage?: TestCoverage; history?: TestHistory } = {}) {
  server.use(
    http.get('/api/status/pipeline', () => HttpResponse.json(pipeline)),
    http.get('/api/status/coverage', () => HttpResponse.json(coverage)),
    http.get('/api/status/history', () => HttpResponse.json(history)),
  );
}

describe('StatusPage', () => {
  it('shows a halt banner with the reason when the pipeline was halted', async () => {
    installStatusHandlers({
      pipeline: {
        run_id: 'r1',
        stages: { sync: { ok: true }, enrich: { ok: false } },
        halted: true,
        halt_reason: 'enrich 0/287 (ratio 0.00 < 0.5)',
        halted_at: 'enrich',
      },
    });

    renderWithProviders(<StatusPage />, { me: { permissions: ['status.view'] } });

    expect(await screen.findByRole('alert', { name: /pipeline halted/i })).toBeInTheDocument();
    expect(screen.getByText(/0\/287/)).toBeInTheDocument();
    expect(screen.getByText('Halted at stage: enrich')).toBeInTheDocument();
  });

  it('does not show a halt banner when the pipeline is healthy', async () => {
    installStatusHandlers();

    renderWithProviders(<StatusPage />, { me: { permissions: ['status.view'] } });

    expect(await screen.findByText('sync')).toBeInTheDocument();
    expect(screen.getByText('enrich')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: /pipeline halted/i })).not.toBeInTheDocument();
  });

  it('shows history rows from backend run history shape', async () => {
    installStatusHandlers();

    renderWithProviders(<StatusPage />, { me: { permissions: ['status.view'] } });

    expect(await screen.findByText('r1 · 3 stages · OK')).toBeInTheDocument();
    expect(screen.getByText('r2 · 2 stages · Failed')).toBeInTheDocument();
  });

  it('shows unknown without OK or Failed when a stage omits ok', async () => {
    installStatusHandlers({
      pipeline: {
        run_id: 'r1',
        stages: { sync: {} },
        halted: false,
        halt_reason: null,
        halted_at: null,
      },
    });

    renderWithProviders(<StatusPage />, { me: { permissions: ['status.view'] } });

    const stageCard = (await screen.findByText('sync')).closest('article');
    if (!stageCard) throw new Error('Expected sync stage card to render.');

    expect(within(stageCard).getByText('Unknown')).toBeInTheDocument();
    expect(within(stageCard).queryByText('OK')).not.toBeInTheDocument();
    expect(within(stageCard).queryByText('Failed')).not.toBeInTheDocument();
    expect(stageCard.querySelector('.lucide-circle-check')).not.toBeInTheDocument();
  });

  it('shows halt fallback copy when no halt reason was reported', async () => {
    installStatusHandlers({
      pipeline: {
        run_id: 'r1',
        stages: { sync: { ok: false } },
        halted: true,
        halt_reason: null,
        halted_at: 'sync',
      },
    });

    renderWithProviders(<StatusPage />, { me: { permissions: ['status.view'] } });

    expect(await screen.findByRole('alert', { name: /pipeline halted/i })).toBeInTheDocument();
    expect(screen.getByText('No halt reason was reported.')).toBeInTheDocument();
    expect(screen.queryByText('null')).not.toBeInTheDocument();
  });

  it('shows coverage totals and unenriched count', async () => {
    installStatusHandlers({ coverage: { total: 287, enriched: 200, unenriched: 87 } });

    renderWithProviders(<StatusPage />, { me: { permissions: ['status.view'] } });

    expect(await screen.findByText(/200 \/ 287 enriched/i)).toBeInTheDocument();
    expect(screen.getByText(/87 unenriched/i)).toBeInTheDocument();
  });
});
