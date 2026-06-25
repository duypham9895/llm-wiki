import { fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../test/util';
import { LibraryPage } from './LibraryPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('LibraryPage', () => {
  it('renders PRDs from the library', async () => {
    server.use(
      http.get('/api/prd/library', () =>
        HttpResponse.json({
          results: [
            {
              id: 'EP-101',
              title: 'Billing workspace',
              status: 'active',
              tags: ['billing'],
              summary: 'Billing improvements',
              source_url: 'https://example.com/billing',
            },
            {
              id: 'EP-102',
              title: 'Search quality',
              status: 'draft',
              tags: ['search'],
              summary: 'Search updates',
              source_url: '',
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    renderWithProviders(<LibraryPage />, { me: { permissions: ['prd.read'] } });

    expect(await screen.findByText('Billing workspace')).toBeInTheDocument();
  });

  it('shows an empty state when no PRDs are found', async () => {
    server.use(
      http.get('/api/prd/library', () => HttpResponse.json({ results: [], next_cursor: null })),
    );

    renderWithProviders(<LibraryPage />, { me: { permissions: ['prd.read'] } });

    expect(await screen.findByText(/no prds found/i)).toBeInTheDocument();
  });

  it('T-3 shows an error when the library fails to load', async () => {
    server.use(
      http.get('/api/prd/library', () => HttpResponse.json({ detail: 'failed' }, { status: 500 })),
    );

    renderWithProviders(<LibraryPage />, { me: { permissions: ['prd.read'] } });

    expect(await screen.findByText(/could not load prds/i)).toBeInTheDocument();
  });

  it('T-4 renders each card as a link to its detail page', async () => {
    server.use(
      http.get('/api/prd/library', () =>
        HttpResponse.json({
          results: [
            {
              id: 'EP-A',
              title: 'Alpha',
              status: 'active',
              tags: [],
              summary: 'Alpha summary',
              source_url: '',
            },
            {
              id: 'EP-B',
              title: 'Beta',
              status: 'active',
              tags: [],
              summary: 'Beta summary',
              source_url: '',
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    renderWithProviders(<LibraryPage />, { me: { permissions: ['prd.read'] } });

    // Each PRD title is now a link to /library/:id (no modal drawer).
    expect(await screen.findByRole('link', { name: /Alpha/ })).toHaveAttribute('href', '/library/EP-A');
    expect(screen.getByRole('link', { name: /Beta/ })).toHaveAttribute('href', '/library/EP-B');
    // No modal drawer anywhere.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close prd reader/i })).not.toBeInTheDocument();
  });

  it('T-5 appends paginated PRDs and hides Load more at the end', async () => {
    server.use(
      http.get('/api/prd/library', ({ request }) => {
        const url = new URL(request.url);

        if (url.searchParams.get('cursor') === 'c2') {
          return HttpResponse.json({
            results: [
              {
                id: 'P2',
                title: 'P2',
                status: 'active',
                tags: [],
                summary: 'Second page',
                source_url: '',
              },
            ],
            next_cursor: null,
          });
        }

        return HttpResponse.json({
          results: [
            {
              id: 'P1',
              title: 'P1',
              status: 'active',
              tags: [],
              summary: 'First page',
              source_url: '',
            },
          ],
          next_cursor: 'c2',
        });
      }),
    );

    renderWithProviders(<LibraryPage />, { me: { permissions: ['prd.read'] } });

    // Card title is now an h3; mock uses title: 'P1' / summary: 'First page'.
    expect(await screen.findByRole('heading', { name: 'P1' })).toBeInTheDocument();
    const loadMore = screen.getByRole('button', { name: /load more/i });
    expect(loadMore).toBeInTheDocument();

    fireEvent.click(loadMore);

    expect(await screen.findByRole('heading', { name: 'P2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});
