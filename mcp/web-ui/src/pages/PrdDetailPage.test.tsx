import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders } from '../test/util';
import { PrdDetailPage } from './PrdDetailPage';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import { toast } from 'sonner';
const toastMock = toast as unknown as ReturnType<typeof vi.fn> & {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  toastMock.info.mockClear();
});
afterAll(() => server.close());

beforeEach(() => {
  // jsdom lacks clipboard.writeText by default; polyfill per test.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

function installPrdHandler(
  prd: Record<string, unknown>,
  options: {
    enrichStatus?: number;
    enrichBody?: unknown;
    enrichStatusSequence?: Array<'running' | 'ok' | 'error' | 'timeout'>;
  } = {},
) {
  const enrichStatus = options.enrichStatus ?? 202;
  const enrichBody =
    options.enrichBody ?? { status: 'running', id: 'job-1', prd_id: (prd.id as string) ?? 'EP-1' };
  // Build the per-poll response sequence (default: running -> ok).
  const sequence = options.enrichStatusSequence ?? (['running', 'ok'] as const);
  let pollIndex = 0;
  server.use(
    http.get('/api/prd/:id', ({ params }) =>
      HttpResponse.json({ ...prd, id: params.id as string }),
    ),
    http.post('/api/prd/:id/enrich', ({ params }) =>
      HttpResponse.json(
        { ...(enrichBody as Record<string, unknown>), prd_id: params.id as string },
        { status: enrichStatus },
      ),
    ),
    http.get('/api/prd/:id/enrich/:jobId', ({ params }) => {
      const status = sequence[Math.min(pollIndex, sequence.length - 1)];
      pollIndex += 1;
      return HttpResponse.json({
        id: params.jobId,
        prd_id: params.id,
        started_at: '2026-06-25T10:00:00Z',
        finished_at: status === 'running' ? null : '2026-06-25T10:05:00Z',
        status,
        error: status === 'error' ? 'something broke' : null,
      });
    }),
  );
}

function renderDetail(opts: { route?: string; me: { permissions: string[] } }) {
  // useParams requires a matching Route; MemoryRouter alone won't expose params.
  // Wrap the page in a Routes/Route pair so useParams resolves the :id segment.
  return renderWithProviders(
    <Routes>
      <Route path="/library/:id" element={<PrdDetailPage />} />
    </Routes>,
    { me: opts.me, route: opts.route ?? '/library/EP-1' },
  );
}

describe('PrdDetailPage', () => {
  it('renders the title, body markdown, and TOC sidebar on the Body tab', async () => {
    installPrdHandler({
      found: true,
      id: 'EP-1',
      title: 'Onboarding redesign',
      status: 'In Review',
      tags: ['ux', 'onboarding'],
      body: '## Background\n\nSome context.\n\n## Goals\n\nShip it.',
      source_url: 'https://notion.so/EP-1',
    });

    renderDetail({ me: { permissions: ['prd.read'] }, route: '/library/EP-1' });

    expect(await screen.findByRole('heading', { name: 'Onboarding redesign' })).toBeInTheDocument();
    // TOC items (use role to disambiguate from the heading of the same name)
    expect(screen.getByRole('link', { name: 'Background' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Goals' })).toBeInTheDocument();
    // Body markdown rendered (h2 element with text)
    expect(screen.getByRole('heading', { name: 'Background' })).toBeInTheDocument();
    expect(screen.getByText('Some context.')).toBeInTheDocument();
  });

  it('switches between Tabs: Metadata shows the dl fields, Body shows markdown', async () => {
    installPrdHandler({
      found: true,
      id: 'EP-2',
      title: 'Metadata test',
      body: '## Section\n\nBody paragraph.',
      pic: { email: 'duy@example.com', name: 'Duy' },
      synced_at: '2026-06-25T10:00:00Z',
      last_edited: '2026-06-25T11:00:00Z',
    });

    renderDetail({ me: { permissions: ['prd.read'] }, route: '/library/EP-2' });

    // Body tab is default.
    expect(await screen.findByText('Body paragraph.')).toBeInTheDocument();

    // Switch to Metadata. Radix Tabs use keyboard activation, so simulate it.
    const metadataTab = screen.getByRole('tab', { name: 'Metadata' });
    metadataTab.focus();
    fireEvent.keyDown(metadataTab, { key: 'Enter' });

    const metadata = await screen.findByTestId('prd-metadata');
    expect(metadata).toHaveTextContent('EP-2');
    expect(metadata).toHaveTextContent('Duy');
    expect(metadata).toHaveTextContent('Synced');
    expect(metadata).toHaveTextContent('Edited');

    // Body tab content should not be visible anymore.
    expect(screen.queryByText('Body paragraph.')).not.toBeInTheDocument();

    // Switch back to Body.
    const bodyTab = screen.getByRole('tab', { name: 'Body' });
    bodyTab.focus();
    fireEvent.keyDown(bodyTab, { key: 'Enter' });
    expect(await screen.findByText('Body paragraph.')).toBeInTheDocument();
  });

  it('opens the actions menu with Copy ID, Copy Obsidian link, Open in Notion, and Re-enrich (4 items)', async () => {
    installPrdHandler({
      found: true,
      id: 'EP-3',
      title: 'Menu test',
      body: '## Intro\n\nBody.',
      source_url: 'https://notion.so/EP-3',
    });

    renderDetail({ me: { permissions: ['prd.read', 'prd.ask'] }, route: '/library/EP-3' });

    expect(await screen.findByRole('heading', { name: 'Menu test' })).toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: /more actions/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Copy ID')).toBeInTheDocument();
    expect(within(menu).getByText('Copy Obsidian link')).toBeInTheDocument();
    // Open in Notion is rendered inside the menu as an <a> link.
    const notionLinks = within(menu).getAllByText('Open in Notion');
    expect(notionLinks.length).toBeGreaterThanOrEqual(1);
    expect(within(menu).getByText('Re-enrich')).toBeInTheDocument();
    // Exactly 4 menu items total.
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(4);
  });

  it('Copy ID writes the PRD id to clipboard and toasts success', async () => {
    installPrdHandler({
      found: true,
      id: 'EP-COPY',
      title: 'Copy test',
      body: '## Intro',
    });

    renderDetail({ me: { permissions: ['prd.read'] }, route: '/library/EP-COPY' });

    expect(await screen.findByRole('heading', { name: 'Copy test' })).toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: /more actions/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    const copyItem = await screen.findByTestId('action-copy-id');
    fireEvent.pointerDown(copyItem, { button: 0 });
    fireEvent.click(copyItem);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('EP-COPY');
    });
    expect(toastMock.success).toHaveBeenCalledWith('Copied PRD ID');
  });

  it('Re-enrich fires POST /api/prd/{id}/enrich and toasts success on 202', async () => {
    installPrdHandler({
      found: true,
      id: 'EP-ENRICH',
      title: 'Enrich test',
      body: '## Intro',
    });

    renderDetail({ me: { permissions: ['prd.read', 'prd.ask'] }, route: '/library/EP-ENRICH' });

    expect(await screen.findByRole('heading', { name: 'Enrich test' })).toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: /more actions/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    const enrichItem = await screen.findByTestId('action-reenrich');
    fireEvent.pointerDown(enrichItem, { button: 0 });
    fireEvent.click(enrichItem);

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith('Enrichment started');
    });
  });

  it('Copy Obsidian link falls back to a constructed URI when obsidian_link is missing', async () => {
    installPrdHandler({
      found: true,
      id: 'EP-OBS',
      title: 'Obsidian test',
      body: '## Intro',
      obsidian_link: undefined,
    });

    renderDetail({ me: { permissions: ['prd.read'] }, route: '/library/EP-OBS' });

    expect(await screen.findByRole('heading', { name: 'Obsidian test' })).toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: /more actions/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    const obsItem = await screen.findByTestId('action-copy-obsidian');
    fireEvent.pointerDown(obsItem, { button: 0 });
    fireEvent.click(obsItem);

    await waitFor(() => {
      // The fallback URI encodes the id; accept either the %20-free or encoded form.
      const calls = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls;
      const wrote = calls.find((c) => String(c[0]).includes('EP-OBS'));
      expect(wrote).toBeTruthy();
    });
    expect(toastMock.success).toHaveBeenCalledWith('Copied Obsidian link');
  });

  it('records a recent view in localStorage on mount when the PRD is found', async () => {
    window.localStorage.clear();
    installPrdHandler({
      found: true,
      id: 'EP-RECENT',
      title: 'Recently viewed PRD',
      body: '## Hello',
    });

    renderDetail({ me: { permissions: ['prd.read'] }, route: '/library/EP-RECENT' });

    expect(await screen.findByRole('heading', { name: 'Recently viewed PRD' })).toBeInTheDocument();

    // The detail page writes via recordLocalRecent(id, title) on the useEffect
    // tick after query.data resolves. Allow one microtask hop.
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('prd:recent-views') ?? '[]');
      expect(stored).toEqual([{ id: 'EP-RECENT', title: 'Recently viewed PRD' }]);
    });
  });

  it('does NOT record a recent view when the PRD is a 404', async () => {
    window.localStorage.clear();
    server.use(
      http.get('/api/prd/:id', () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'PRD not found' } }, { status: 404 }),
      ),
    );

    renderDetail({ me: { permissions: ['prd.read'] }, route: '/library/EP-NOPE' });

    // The empty-state copy confirms the page saw the 404.
    expect(await screen.findByText(/couldn't find a prd with id "ep-nope"/i)).toBeInTheDocument();

    // Storage stays empty — only successful loads pollute recents.
    expect(window.localStorage.getItem('prd:recent-views')).toBeNull();
  });

  it('Re-enrich POST returns job_id, UI shows running state, GET poll resolves to ok -> toast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installPrdHandler(
        {
          found: true,
          id: 'EP-POLL',
          title: 'Polling test',
          body: '## Intro',
        },
        // First poll says running, second says ok — exercises the
        // running->terminal transition that triggers the success toast.
        { enrichStatusSequence: ['running', 'ok'] },
      );

      renderDetail({ me: { permissions: ['prd.read', 'prd.ask'] }, route: '/library/EP-POLL' });

      expect(await screen.findByRole('heading', { name: 'Polling test' })).toBeInTheDocument();

      const trigger = screen.getByRole('button', { name: /more actions/i });
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.click(trigger);
      const enrichItem = await screen.findByTestId('action-reenrich');
      fireEvent.pointerDown(enrichItem, { button: 0 });
      fireEvent.click(enrichItem);

      // Mutation resolves -> toast.success('Enrichment started') + job id captured.
      await waitFor(() => {
        expect(toastMock.success).toHaveBeenCalledWith('Enrichment started');
      });

      // Progress banner appears while the first poll returns running.
      const banner = await screen.findByTestId('enrich-progress');
      expect(banner).toBeInTheDocument();
      expect(banner).toHaveTextContent(/enrichment running/i);

      // Second poll (after the 2s refetch interval) returns ok, the polling
      // query stops, and the success toast fires.
      await waitFor(
        () => {
          expect(toastMock.success).toHaveBeenCalledWith('Enrichment finished');
        },
        { timeout: 4000 },
      );

      // Banner clears once the job leaves running.
      await waitFor(() => {
        expect(screen.queryByTestId('enrich-progress')).not.toBeInTheDocument();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Re-enrich error poll surfaces a failure toast with the server error message', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installPrdHandler(
        {
          found: true,
          id: 'EP-FAIL',
          title: 'Fail test',
          body: '## Intro',
        },
        { enrichStatusSequence: ['running', 'error'] },
      );

      renderDetail({ me: { permissions: ['prd.read', 'prd.ask'] }, route: '/library/EP-FAIL' });

      expect(await screen.findByRole('heading', { name: 'Fail test' })).toBeInTheDocument();

      const trigger = screen.getByRole('button', { name: /more actions/i });
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.click(trigger);
      const enrichItem = await screen.findByTestId('action-reenrich');
      fireEvent.pointerDown(enrichItem, { button: 0 });
      fireEvent.click(enrichItem);

      await waitFor(() => {
        expect(toastMock.success).toHaveBeenCalledWith('Enrichment started');
      });

      await waitFor(
        () => {
          expect(toastMock.error).toHaveBeenCalledWith('Enrichment failed: something broke');
        },
        { timeout: 4000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// Tiny `within` helper used in menu assertions (avoids extra import).
function within(element: HTMLElement) {
  return {
    getByText: (text: string | RegExp) => {
      const match =
        typeof text === 'string'
          ? Array.from(element.querySelectorAll('*')).find(
              (el) => el.textContent?.trim() === text,
            )
          : Array.from(element.querySelectorAll('*')).find((el) =>
              text.test(el.textContent ?? ''),
            );
      if (!match) throw new Error(`No element with text ${text}`);
      return match as HTMLElement;
    },
    getAllByText: (text: string | RegExp) => {
      const matches = Array.from(element.querySelectorAll('*')).filter((el) =>
        typeof text === 'string'
          ? el.textContent?.includes(text)
          : text.test(el.textContent ?? ''),
      );
      return matches as HTMLElement[];
    },
    getAllByRole: (role: string) =>
      Array.from(element.querySelectorAll(`[role="${role}"]`)) as HTMLElement[],
  };
}