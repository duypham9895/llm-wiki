import { fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../test/util';
import { SearchPage } from './SearchPage';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  navigateMock.mockReset();
});
afterAll(() => server.close());

function submitSearch(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: /search prds/i }), {
    target: { value },
  });
  fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
}

// Highlighted text is split across <mark> wrappers, so match on full textContent.
function findWhole(text: string) {
  return screen.findByText((_, node) => node?.textContent === text);
}

const MIXED_STATUS_RESPONSE = {
  count: 3,
  verdict: 'match' as const,
  results: [
    {
      id: 'EP-457',
      title: 'Referral revamp plan',
      summary: 'A referral overhaul',
      tags: ['referral'],
      status: 'active',
      source_url: '',
      obsidian_link: '',
      snippet: 'The referral flow needs work',
      score: 0.8,
    },
    {
      id: 'EP-458',
      title: 'Onboarding draft',
      summary: 'Draft onboarding doc',
      tags: ['onboarding'],
      status: 'draft',
      source_url: '',
      obsidian_link: '',
      snippet: 'Onboarding steps',
      score: 0.6,
    },
    {
      id: 'EP-459',
      title: 'Active billing spec',
      summary: 'Billing details',
      tags: ['billing'],
      status: 'active',
      source_url: '',
      obsidian_link: '',
      snippet: 'Billing notes',
      score: 0.5,
    },
  ],
};

describe('SearchPage', () => {
  it('shows an honest empty state when semantic search has no match', async () => {
    server.use(
      http.get('/api/prd/search', () =>
        HttpResponse.json({ count: 0, verdict: 'no_match', results: [] }),
      ),
    );

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds/i }), {
      target: { value: 'billing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText(/no prd covers this/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('T-1 suppresses non-empty semantic results when the verdict is no_match', async () => {
    server.use(
      http.get('/api/prd/search', () =>
        HttpResponse.json({
          count: 2,
          verdict: 'no_match',
          results: [
            {
              id: 'EP-459',
              title: 'Suppressed semantic result',
              summary: 'Should not render',
              tags: [],
              status: 'active',
              source_url: '',
              obsidian_link: '',
              snippet: 'Hidden hit',
              score: 0.7,
            },
          ],
        }),
      ),
    );

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds/i }), {
      target: { value: 'pricing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText(/no prd covers this/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('renders semantic search matches', async () => {
    server.use(
      http.get('/api/prd/search', () =>
        HttpResponse.json({
          count: 1,
          verdict: 'match',
          results: [
            {
              id: 'EP-457',
              title: 'Referral revamp',
              summary: 'x',
              tags: ['referral'],
              status: 'active',
              source_url: '',
              obsidian_link: '',
              snippet: 's',
              score: 0.4,
            },
          ],
        }),
      ),
    );

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    submitSearch('referral');

    // Title text is split by <mark> highlight wrappers, so match on textContent.
    expect(
      await screen.findByText((_, node) => node?.textContent === 'Referral revamp'),
    ).toBeInTheDocument();
  });

  it('renders keyword results without a verdict', async () => {
    server.use(
      http.get('/api/prd/search', () =>
        HttpResponse.json({
          count: 1,
          results: [
            {
              id: 'EP-458',
              title: 'Keyword launch plan',
              summary: 'Keyword summary',
              tags: ['search'],
              status: 'draft',
              source_url: '',
              obsidian_link: '',
              snippet: 'Keyword hit',
            },
          ],
        }),
      ),
    );

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    fireEvent.click(screen.getByRole('radio', { name: /keyword/i }));
    submitSearch('launch');

    expect(
      await screen.findByText((_, node) => node?.textContent === 'Keyword launch plan'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Score /)).toBeNull();
  });

  it('T-2 shows keyword empty state when no keyword results are found', async () => {
    server.use(
      http.get('/api/prd/search', () => HttpResponse.json({ count: 0, results: [] })),
    );

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    fireEvent.click(screen.getByRole('radio', { name: /keyword/i }));
    fireEvent.change(screen.getByRole('searchbox', { name: /search prds/i }), {
      target: { value: 'unknown keyword' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText(/no prds found/i)).toBeInTheDocument();
    expect(screen.getByText(/broader keyword/i)).toBeInTheDocument();
  });

  it('T-3 shows an error when search fails', async () => {
    server.use(
      http.get('/api/prd/search', () => HttpResponse.json({ detail: 'failed' }, { status: 500 })),
    );

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    submitSearch('billing');

    expect(await screen.findByText(/could not search prds/i)).toBeInTheDocument();
  });

  it('shows example query chips before any search and runs one when clicked', async () => {
    server.use(
      http.get('/api/prd/search', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('q')).toBe('LTV cap');
        return HttpResponse.json({
          count: 1,
          verdict: 'match',
          results: [
            {
              id: 'EP-460',
              title: 'LTV cap policy',
              summary: 'x',
              tags: [],
              status: 'active',
              source_url: '',
              obsidian_link: '',
              snippet: 's',
              score: 0.9,
            },
          ],
        });
      }),
    );

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    expect(screen.getByText(/search the prd library/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'LTV cap' }));

    expect(await findWhole('LTV cap policy')).toBeInTheDocument();
  });

  it('highlights matched query terms in titles and snippets', async () => {
    server.use(http.get('/api/prd/search', () => HttpResponse.json(MIXED_STATUS_RESPONSE)));

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    submitSearch('referral');

    const heading = await screen.findByText((_, node) => node?.textContent === 'Referral revamp plan');
    const marks = within(heading as HTMLElement).getAllByText(/referral/i, { selector: 'mark' });
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]).toHaveClass('bg-primary/20');
  });

  it('escapes regex special characters in the query so highlight does not crash', async () => {
    server.use(
      http.get('/api/prd/search', () =>
        HttpResponse.json({
          count: 1,
          verdict: 'match',
          results: [
            {
              id: 'EP-461',
              title: 'Cost (per unit) breakdown',
              summary: 'x',
              tags: [],
              status: 'active',
              source_url: '',
              obsidian_link: '',
              snippet: 's',
              score: 0.5,
            },
          ],
        }),
      ),
    );

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    submitSearch('(per unit)');

    expect(await screen.findByText((_, node) => node?.textContent === 'Cost (per unit) breakdown')).toBeInTheDocument();
  });

  it('filters results by status chip with per-status counts', async () => {
    server.use(http.get('/api/prd/search', () => HttpResponse.json(MIXED_STATUS_RESPONSE)));

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    submitSearch('referral');

    await findWhole('Referral revamp plan');
    expect(screen.getAllByRole('article')).toHaveLength(3);

    // Chip labels carry the per-status counts.
    expect(screen.getByRole('button', { name: /^all 3$/i })).toBeInTheDocument();
    const draftChip = screen.getByRole('button', { name: /^draft 1$/i });
    expect(screen.getByRole('button', { name: /^active 2$/i })).toBeInTheDocument();

    fireEvent.click(draftChip);

    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('Onboarding draft')).toBeInTheDocument();
    expect(screen.queryByText('Referral revamp plan')).toBeNull();
  });

  it('navigates with keyboard: j/k moves the cursor and Enter opens the active result', async () => {
    server.use(http.get('/api/prd/search', () => HttpResponse.json(MIXED_STATUS_RESPONSE)));

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    submitSearch('referral');
    await findWhole('Referral revamp plan');

    // Move off the search box first so the keydown guard does not skip us.
    document.body.focus();

    // First card is active by default.
    let articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveAttribute('aria-current', 'true');

    fireEvent.keyDown(document.body, { key: 'j' });
    articles = screen.getAllByRole('article');
    expect(articles[1]).toHaveAttribute('aria-current', 'true');

    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(navigateMock).toHaveBeenCalledWith('/library/EP-458');

    fireEvent.keyDown(document.body, { key: 'k' });
    articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveAttribute('aria-current', 'true');
  });

  it('does not hijack keys while the search input is focused', async () => {
    server.use(http.get('/api/prd/search', () => HttpResponse.json(MIXED_STATUS_RESPONSE)));

    renderWithProviders(<SearchPage />, { me: { permissions: ['prd.read'] } });

    submitSearch('referral');
    await findWhole('Referral revamp plan');

    const searchbox = screen.getByRole('searchbox', { name: /search prds/i });
    searchbox.focus();
    fireEvent.keyDown(searchbox, { key: 'Enter' });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getAllByRole('article')[0]).toHaveAttribute('aria-current', 'true');
  });
});
