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
const RUN_STARTED_AT = '2026-06-25T10:35:00.000Z';
const RUNNING_RUN = {
  id: RUN_ID,
  source_id: 'notion',
  started_at: RUN_STARTED_AT,
  finished_at: null,
  status: 'running',
  counts: null,
  error: null,
};

const SSE_ENCODER = new TextEncoder();

function makeSSEResponse(chunks: string[], init: ResponseInit = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(SSE_ENCODER.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      ...init,
      headers: {
        'Content-Type': 'text/event-stream',
        ...(init.headers ?? {}),
      },
    },
  );
}

function installSourcesHandlers(opts: {
  source?: object;
  runResponse?: object | (() => Response);
  runs?: object[];
  /** When set, the /stream endpoint returns these SSE chunks. When omitted
   *  the default handler responds with an empty stream so the panel stays in
   *  its "waiting for output" state without hitting the network. */
  streamChunks?: string[] | (() => string[]);
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
    http.get(`/api/admin/sources/notion/runs/${RUN_ID}`, () => HttpResponse.json(RUNNING_RUN)),
    http.get(`/api/admin/sources/notion/runs/${RUN_ID}/stream`, () => {
      const chunks = typeof opts.streamChunks === 'function'
        ? opts.streamChunks()
        : opts.streamChunks ?? [];
      return makeSSEResponse(chunks);
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

  it('renders stage and status filter dropdowns above the history list', async () => {
    installSourcesHandlers();

    renderSources({ permissions: ['users.manage'] });

    const stageTrigger = await screen.findByTestId('stage-filter-trigger');
    const statusTrigger = await screen.findByTestId('status-filter-trigger');

    // Default "all" labels render inside each trigger
    expect(within(stageTrigger).getByText('All stages')).toBeInTheDocument();
    expect(within(statusTrigger).getByText('All statuses')).toBeInTheDocument();
  });

  it('status=error filter narrows the list to failed runs; status=timeout shows the empty hint', async () => {
    installSourcesHandlers({
      runs: [
        {
          id: 'r-ok',
          source_id: 'notion',
          started_at: '2026-06-25T10:30:00.000Z',
          finished_at: '2026-06-25T10:30:05.000Z',
          status: 'ok',
          counts: { synced: 4, skipped: 0, archived: 0, errors: 0 },
          error: null,
        },
        {
          id: 'r-err',
          source_id: 'notion',
          started_at: '2026-06-25T09:30:00.000Z',
          finished_at: '2026-06-25T09:30:02.000Z',
          status: 'error',
          counts: { synced: 0, skipped: 0, archived: 0, errors: 2 },
          error: 'sync failed',
        },
      ],
    });

    renderSources({ permissions: ['users.manage'] });

    // Default: both runs visible
    const list = await screen.findByTestId('recent-runs');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    // Open the status filter and pick "Error"
    fireEvent.click(screen.getByTestId('status-filter-trigger'));
    const errorOption = await screen.findByRole('option', { name: 'Error' });
    fireEvent.click(errorOption);

    // Only the error run remains
    await waitFor(() => {
      expect(within(screen.getByTestId('recent-runs')).getAllByRole('listitem')).toHaveLength(1);
    });
    expect(within(screen.getByTestId('recent-runs')).getByText('error')).toBeInTheDocument();

    // Pick "Timeout" — no runs match → empty hint replaces the list
    fireEvent.click(screen.getByTestId('status-filter-trigger'));
    const timeoutOption = await screen.findByRole('option', { name: 'Timeout' });
    fireEvent.click(timeoutOption);

    expect(await screen.findByTestId('no-runs-hint')).toHaveTextContent(/no runs match/i);
    expect(screen.queryByTestId('recent-runs')).not.toBeInTheDocument();
  });

  it('default All stages + All statuses shows every run with no hint', async () => {
    installSourcesHandlers({
      runs: [
        {
          id: 'r-ok',
          source_id: 'notion',
          started_at: '2026-06-25T10:30:00.000Z',
          finished_at: '2026-06-25T10:30:05.000Z',
          status: 'ok',
          counts: { synced: 4, skipped: 0, archived: 0, errors: 0 },
          error: null,
        },
        {
          id: 'r-running',
          source_id: 'notion',
          started_at: '2026-06-25T11:00:00.000Z',
          finished_at: null,
          status: 'running',
          counts: null,
          error: null,
        },
        {
          id: 'r-timeout',
          source_id: 'notion',
          started_at: '2026-06-25T08:00:00.000Z',
          finished_at: '2026-06-25T08:05:00.000Z',
          status: 'timeout',
          counts: { synced: 0, skipped: 0, archived: 0, errors: 0 },
          error: 'timeout',
        },
      ],
    });

    renderSources({ permissions: ['users.manage'] });

    const list = await screen.findByTestId('recent-runs');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByTestId('no-runs-hint')).not.toBeInTheDocument();
  });
});

describe('RunLogPanel (live SSE log stream)', () => {
  it('renders streamed log lines and flips header to final status when done arrives', async () => {
    installSourcesHandlers({
      source: { status: 'running' },
      runs: [RUNNING_RUN],
      streamChunks: () => [
        'event: log\ndata: starting sync\n\n',
        'event: log\ndata: skipped 2 stale rows\n\n',
        'event: log\ndata: synced 4 pages\n\n',
        'event: log\ndata: error: rate limited, backing off\n\n',
        'event: done\ndata: error\n\n',
      ],
    });

    renderSources({ permissions: ['users.manage'] });

    // Panel mounts because source.status === 'running' AND runRow exists.
    await screen.findByTestId('run-log-panel');

    // All four log lines render inside the panel body, in arrival order.
    const body = screen.getByTestId('run-log-body');
    expect(within(body).getByText('starting sync')).toBeInTheDocument();
    expect(within(body).getByText('skipped 2 stale rows')).toBeInTheDocument();
    expect(within(body).getByText('synced 4 pages')).toBeInTheDocument();
    expect(within(body).getByText('error: rate limited, backing off')).toBeInTheDocument();

    // Color-coding: green for synced, yellow for skipped, red for error.
    const syncedNode = within(body).getByText('synced 4 pages');
    expect(syncedNode.className).toMatch(/emerald|green/);
    const skippedNode = within(body).getByText('skipped 2 stale rows');
    expect(skippedNode.className).toMatch(/yellow/);
    const errorNode = within(body).getByText('error: rate limited, backing off');
    expect(errorNode.className).toMatch(/red/);

    // After done: header text shows the final status (no more "Running" prefix).
    await waitFor(() => {
      expect(screen.getByTestId('run-log-header').textContent).toBe('error');
    });
  });

  it('renders the "waiting for subprocess output" placeholder when the stream sends no events', async () => {
    installSourcesHandlers({
      source: { status: 'running' },
      runs: [RUNNING_RUN],
      // Default streamChunks = [] — empty stream, no SSE frames at all.
    });

    renderSources({ permissions: ['users.manage'] });

    // Panel + header appear, but body shows the "waiting for output" placeholder
    // instead of any log lines.
    await screen.findByTestId('run-log-panel');
    expect(
      await screen.findByText(/waiting for subprocess output/i),
    ).toBeInTheDocument();
  });
});

describe('NotionHealthBanner', () => {
  function installNotionHealth(handler: Parameters<typeof server.use>[0]) {
    installSourcesHandlers();
    server.use(handler);
  }

  it('shows green check when health=ok with bot and workspace names', async () => {
    installNotionHealth(
      http.get('/api/prd/_health/notion', () =>
        HttpResponse.json({
          status: 'ok',
          token_prefix: 'ntn_I_',
          bot_name: 'PRD Sync',
          workspace_name: 'Ringkas',
        }),
      ),
    );

    renderSources({ permissions: ['users.manage'] });

    expect(await screen.findByText('Notion connected')).toBeInTheDocument();
    expect(screen.getByText(/PRD Sync/)).toBeInTheDocument();
    expect(screen.getByText(/Ringkas/)).toBeInTheDocument();
    expect(screen.getByText(/ntn_I_/)).toBeInTheDocument();
  });

  it('falls back to generic copy when ok response lacks bot_name', async () => {
    installNotionHealth(
      http.get('/api/prd/_health/notion', () =>
        HttpResponse.json({
          status: 'ok',
          token_prefix: 'ntn_I_abc',
        }),
      ),
    );

    renderSources({ permissions: ['users.manage'] });

    expect(await screen.findByText('Notion connected')).toBeInTheDocument();
    expect(screen.getByText(/Notion API reachable/)).toBeInTheDocument();
    expect(screen.getByText(/ntn_I_abc/)).toBeInTheDocument();
  });

  it('shows destructive alert with fix steps when wrong_token_type', async () => {
    installNotionHealth(
      http.get('/api/prd/_health/notion', () =>
        HttpResponse.json({
          status: 'wrong_token_type',
          message: 'Notion returned 403 — Personal Access Token',
          fix_url: 'https://www.notion.so/profile/integrations',
        }),
      ),
    );

    renderSources({ permissions: ['users.manage'] });

    expect(await screen.findByText('Wrong Notion token type')).toBeInTheDocument();
    expect(screen.getByText(/Personal Access Token/)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /open notion integrations/i });
    expect(link).toHaveAttribute('href', 'https://www.notion.so/profile/integrations');

    // 5-step ordered list with required operator guidance
    expect(screen.getByText(/Notion → Settings → Connections/)).toBeInTheDocument();
    expect(screen.getByText(/Internal Integration Secret/)).toBeInTheDocument();
    expect(screen.getByText(/Product Backlog database/)).toBeInTheDocument();
    const list = screen.getByRole('list');
    expect(list).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  it('shows destructive alert with token title when wrong_token', async () => {
    installNotionHealth(
      http.get('/api/prd/_health/notion', () =>
        HttpResponse.json({
          status: 'wrong_token',
          message: 'Notion returned 401 unauthorized',
          fix_url: 'https://www.notion.so/profile/integrations',
        }),
      ),
    );

    renderSources({ permissions: ['users.manage'] });

    expect(await screen.findByText('Notion rejected the token')).toBeInTheDocument();
    expect(screen.getByText(/401 unauthorized/)).toBeInTheDocument();
    expect(screen.getByText(/Notion → Settings → Connections/)).toBeInTheDocument();
  });

  it('shows destructive alert with missing title when status=missing', async () => {
    installNotionHealth(
      http.get('/api/prd/_health/notion', () =>
        HttpResponse.json({
          status: 'missing',
          message: 'NOTION_TOKEN env var is not set',
        }),
      ),
    );

    renderSources({ permissions: ['users.manage'] });

    expect(await screen.findByText('NOTION_TOKEN is not set')).toBeInTheDocument();
    expect(screen.getByText(/NOTION_TOKEN env var is not set/)).toBeInTheDocument();
    // No fix_url → no link rendered
    expect(screen.queryByRole('link', { name: /open notion integrations/i })).not.toBeInTheDocument();
  });

  it('shows destructive alert with rate-limited title when status=rate_limited', async () => {
    installNotionHealth(
      http.get('/api/prd/_health/notion', () =>
        HttpResponse.json({
          status: 'rate_limited',
          message: 'Notion returned 429 — backing off',
          fix_url: 'https://www.notion.so/profile/integrations',
        }),
      ),
    );

    renderSources({ permissions: ['users.manage'] });

    expect(await screen.findByText('Notion rate-limited the health check')).toBeInTheDocument();
    expect(screen.getByText(/429 — backing off/)).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('shows destructive alert with unreachable title when status=unreachable', async () => {
    installNotionHealth(
      http.get('/api/prd/_health/notion', () =>
        HttpResponse.json({
          status: 'unreachable',
          message: 'Could not reach api.notion.com',
          fix_url: 'https://www.notionstatus.com',
        }),
      ),
    );

    renderSources({ permissions: ['users.manage'] });

    expect(await screen.findByText('Notion API unreachable')).toBeInTheDocument();
    expect(screen.getByText(/Could not reach api.notion.com/)).toBeInTheDocument();
  });

  it('does not render the banner while health is loading', async () => {
    installSourcesHandlers();

    // Slow handler so the query stays in the loading state for the assertion window.
    server.use(
      http.get('/api/prd/_health/notion', async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return HttpResponse.json({ status: 'ok', token_prefix: 'ntn_I_' });
      }),
    );

    renderSources({ permissions: ['users.manage'] });

    // Wait for the page itself to render, then assert no banner text yet.
    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeInTheDocument();
    expect(screen.queryByText('Notion connected')).not.toBeInTheDocument();
    expect(screen.queryByText('NOTION_TOKEN is not set')).not.toBeInTheDocument();
    expect(screen.queryByText('Notion API unreachable')).not.toBeInTheDocument();
  });
});
