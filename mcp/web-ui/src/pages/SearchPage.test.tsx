import { fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../test/util';
import { SearchPage } from './SearchPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds/i }), {
      target: { value: 'referral' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText('Referral revamp')).toBeInTheDocument();
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
    fireEvent.change(screen.getByRole('searchbox', { name: /search prds/i }), {
      target: { value: 'launch' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText('Keyword launch plan')).toBeInTheDocument();
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

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds/i }), {
      target: { value: 'billing' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    expect(await screen.findByText(/could not search prds/i)).toBeInTheDocument();
  });
});
