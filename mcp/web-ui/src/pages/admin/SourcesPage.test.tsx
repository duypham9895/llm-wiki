import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';

import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { Toaster } from '@/components/ui/sonner';
import { makeMe } from '../../test/util';
import { SourcesPage } from './SourcesPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderSources(me: { permissions: string[] }, route = '/admin/sources') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['me'], makeMe(me));
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[route]}>
            <AuthProvider fallback={<p>Loading</p>} onUnauthenticated={<p>Please sign in</p>}>
              {children}
            </AuthProvider>
          </MemoryRouter>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    );
  }
  return render(<SourcesPage />, { wrapper: Wrapper });
}

const FIXED_LAST_RUN = '2026-06-25T10:30:00.000Z';
const RUN_ID = 'run-123';

function installSourcesHandlers(opts: {
  source?: object;
  runResponse?: object | (() => Response);
  runs?: object[];
} = {}) {
  const source = {
    id: 'notion',
    kind: 'notion',
    label: 'Notion',
    subtitle: 'Database: Product Backlog (3f6ac861-…)',
    status: 'ok',
    last_run_at: FIXED_LAST_RUN,
    last_run_summary: { synced: 4, skipped: 0, archived: 0, errors: 0 },
    schedule: 'every 4 hours',
    ...opts.source,
  };

  server.use(
    http.get('/api/admin/sources', () => HttpResponse.json([source])),
    http.get('/api/admin/sources/notion/runs', () =>
      HttpResponse.json(
        opts.runs ?? [
          {
            id: 'r-old',
            source_id: 'notion',
            started_at: FIXED_LAST_RUN,
            finished_at: FIXED_LAST_RUN,
            status: 'ok',
            counts: { synced: 4, skipped: 0, archived: 0, errors: 0 },
            error: null,
          },
        ],
      ),
    ),
    http.post('/api/admin/sources/notion/run', () => {
      if (typeof opts.runResponse === 'function') return opts.runResponse();
      if (opts.runResponse) return HttpResponse.json(opts.runResponse);
      return HttpResponse.json(
        {
          id: RUN_ID,
          source_id: 'notion',
          started_at: new Date().toISOString(),
          finished_at: null,
          status: 'running',
          counts: null,
          error: null,
        },
        { status: 202 },
      );
    }),
  );
}

describe('SourcesPage', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('renders the Notion source card with last-run summary', async () => {
    installSourcesHandlers();

    renderSources({ permissions: ['users.manage'] });

    expect(await screen.findByRole('heading', { name: 'Sources' }, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByText('Notion', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/Database: Product Backlog/)).toBeInTheDocument();

    // The summary text is split across multiple <span> nodes, so check via DOM.
    const card = screen.getByText('Notion').closest('[class*="rounded-lg"]') ?? document.body;
    expect(card.textContent).toMatch(/synced 4/);

    const runsList = await screen.findByTestId('recent-runs');
    expect(within(runsList).getByText('ok')).toBeInTheDocument();
  });

  it('opens the confirm dialog when Run now is clicked', async () => {
    installSourcesHandlers();

    renderSources({ permissions: ['users.manage'] });

    const runNow = await screen.findByRole('button', { name: /run now/i }, { timeout: 3000 });
    fireEvent.click(runNow);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/write to the vault/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /run sync/i })).toBeInTheDocument();
  });

  it('confirms the run mutation and shows a success toast', async () => {
    installSourcesHandlers();

    renderSources({ permissions: ['users.manage'] });

    fireEvent.click(await screen.findByRole('button', { name: /run now/i }, { timeout: 3000 }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /run sync/i }));

    const toast = await screen.findByText(/sync started/i, {}, { timeout: 3000 });
    expect(toast).toBeInTheDocument();
  });

  it('shows an error toast and re-enables the button when the API fails', async () => {
    installSourcesHandlers({
      runResponse: () =>
        HttpResponse.json(
          { error: { code: 'http_error', message: 'service unavailable' } },
          { status: 503 },
        ),
    });

    renderSources({ permissions: ['users.manage'] });

    fireEvent.click(await screen.findByRole('button', { name: /run now/i }, { timeout: 3000 }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /run sync/i }));

    expect(await screen.findByText(/service unavailable/i, {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
    });
  });
});
