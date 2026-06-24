import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../../../test/util';
import { DirectoryPage } from '../DirectoryPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function installDirectoryHandlers() {
  server.use(
    http.get('/api/admin/users', ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('status')).toBe('active');

      return HttpResponse.json({
        users: [
          {
            id: 'u1',
            email: 'alice@x.com',
            status: 'active',
            roles: [{ id: 'r1', name: 'admin' }],
            created_at: '2026-01-01',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });
    }),
    http.get('/api/admin/roles', () =>
      HttpResponse.json({
        roles: [{ id: 'r1', name: 'admin', is_system: true, permissions: ['users.manage', 'roles.manage'] }],
      }),
    ),
  );
}

describe('DirectoryPage', () => {
  it('shows friendly copy when deleting the last active admin', async () => {
    installDirectoryHandlers();
    server.use(
      http.delete('/api/admin/users/u1', () =>
        HttpResponse.json({ error: { code: 'last_admin', message: 'last admin' } }, { status: 409 }),
      ),
    );

    renderWithProviders(<DirectoryPage />, { me: { permissions: ['users.manage'] }, route: '/admin/directory' });

    fireEvent.click(within(await screen.findByTestId('user-u1')).getByRole('button', { name: /delete alice@x\.com/i }));

    expect(await screen.findByText(/no active admin/i)).toBeInTheDocument();
    expect(screen.queryByText('last_admin')).not.toBeInTheDocument();
  });

  it('resets a user password and sends the new password body', async () => {
    installDirectoryHandlers();
    let resetBody: { password?: unknown } | null = null;
    server.use(
      http.post('/api/admin/users/u1/reset-password', async ({ request }) => {
        resetBody = (await request.json()) as { password?: unknown };
        return HttpResponse.json({ status: 'ok' });
      }),
    );

    renderWithProviders(<DirectoryPage />, { me: { permissions: ['users.manage'] }, route: '/admin/directory' });

    fireEvent.click(
      within(await screen.findByTestId('user-u1')).getByRole('button', { name: /reset password for alice@x\.com/i }),
    );
    const dialog = within(screen.getByRole('dialog', { name: /reset password/i }));
    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: 'NewPass123!' } });
    fireEvent.click(dialog.getByRole('button', { name: /set password/i }));

    await waitFor(() => expect(resetBody).toEqual({ password: 'NewPass123!' }));
    expect(await screen.findByText(/password reset/i)).toBeInTheDocument();
  });

  it('shows friendly copy when changing roles would create a half-admin grant', async () => {
    installDirectoryHandlers();
    server.use(
      http.put('/api/admin/users/u1/roles', () =>
        HttpResponse.json({ error: { code: 'admin_pair', message: 'half admin' } }, { status: 422 }),
      ),
    );

    renderWithProviders(<DirectoryPage />, { me: { permissions: ['users.manage'] }, route: '/admin/directory' });

    fireEvent.click(
      within(await screen.findByTestId('user-u1')).getByRole('button', { name: /save roles for alice@x\.com/i }),
    );

    expect(await screen.findByText(/admin.*(fully or not at all|pairs)/i)).toBeInTheDocument();
    expect(screen.queryByText('admin_pair')).not.toBeInTheDocument();
  });
});
