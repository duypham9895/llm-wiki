import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../test/util';
import { LibraryPage } from './LibraryPage';

/** Radix Select opens on `pointerdown`; `fireEvent.click` alone is not enough
 *  in jsdom. Mirror the pattern used by DirectoryPage.test.tsx for DropdownMenu.
 *  Also dispatch `keydown` (ArrowDown) as a fallback — Radix listens to keyboard
 *  for selection and the pointerDown alone sometimes doesn't trigger the portal
 *  to open in jsdom. */
function openSelect(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);
  // Belt-and-braces: dispatch keyboard activation too. jsdom sometimes drops
  // pointer events when the trigger has no layout.
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown', bubbles: true });
}

function within(element: HTMLElement) {
  return {
    getByRole: (role: string, options?: { name?: string | RegExp }) => {
      const name = options?.name;
      const matches = Array.from(element.querySelectorAll(`[role="${role}"]`));
      const filtered = name
        ? matches.filter((el) => {
            const text = el.textContent ?? '';
            return typeof name === 'string' ? text.trim() === name : name.test(text);
          })
        : matches;
      if (filtered.length === 0) throw new Error(`No ${role} with name ${String(name)}`);
      return filtered[0] as HTMLElement;
    },
  };
}

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

  it('T-6 status filter dropdown exposes all 7 enums (mirror of STATUS_BADGE map)', async () => {
    server.use(
      http.get('/api/prd/library', () =>
        HttpResponse.json({ results: [], next_cursor: null }),
      ),
    );

    renderWithProviders(<LibraryPage />, { me: { permissions: ['prd.read'] } });

    // Open the status Select trigger.
    const trigger = await screen.findByRole('combobox', { name: /status/i });
    openSelect(trigger);

    // Wait for the listbox to mount — Radix Select portals its content into
    // document.body, so waitFor + global query handles the async portaling.
    await waitFor(() => {
      expect(document.querySelector('[role="listbox"]')).toBeInTheDocument();
    });
    const listbox = document.querySelector('[role="listbox"]') as HTMLElement;
    const expected = [
      'All statuses',
      'Active',
      'Draft',
      'Archived',
      'Done',
      'In Review',
      'In Progress',
      'Not Started',
    ];
    for (const label of expected) {
      expect(within(listbox).getByRole('option', { name: label })).toBeInTheDocument();
    }

    // Selecting a non-'all' value sends the matching ?status= verbatim.
    fireEvent.click(within(listbox).getByRole('option', { name: 'Done' }));

    // The trigger now shows "Done" as the selected value.
    await waitFor(() => {
      expect(trigger.textContent).toContain('Done');
    });
  });

  it('T-7 status filter sends the value verbatim to the backend', async () => {
    let capturedStatus: string | null = null;
    server.use(
      http.get('/api/prd/library', ({ request }) => {
        const url = new URL(request.url);
        capturedStatus = url.searchParams.get('status');
        return HttpResponse.json({ results: [], next_cursor: null });
      }),
    );

    renderWithProviders(<LibraryPage />, { me: { permissions: ['prd.read'] } });

    const trigger = await screen.findByRole('combobox', { name: /status/i });
    openSelect(trigger);
    await waitFor(() => {
      expect(document.querySelector('[role="listbox"]')).toBeInTheDocument();
    });
    const listbox = document.querySelector('[role="listbox"]') as HTMLElement;
    fireEvent.click(within(listbox).getByRole('option', { name: 'In Review' }));

    await waitFor(() => {
      expect(capturedStatus).toBe('In Review');
    });
  });
});
