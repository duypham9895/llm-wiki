import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../../../test/util';
import { ApprovalsPage } from '../ApprovalsPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function installApprovalsHandlers() {
  server.use(
    http.get('/api/admin/users', ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('status')).toBe('pending');

      return HttpResponse.json({
        users: [{ id: 'u1', email: 'bob@x.com', status: 'pending', roles: [], created_at: '2026-01-01' }],
        total: 1,
        limit: 50,
        offset: 0,
      });
    }),
    http.get('/api/admin/roles', () =>
      HttpResponse.json({ roles: [{ id: 'r1', name: 'member', is_system: true, permissions: ['wiki.read'] }] }),
    ),
  );
}

describe('ApprovalsPage', () => {
  it('shows friendly copy when approving would create a half-admin role grant', async () => {
    installApprovalsHandlers();
    server.use(
      http.post('/api/admin/users/u1/approve', () =>
        HttpResponse.json({ error: { code: 'admin_pair', message: 'half admin' } }, { status: 422 }),
      ),
    );

    renderWithProviders(<ApprovalsPage />, { me: { permissions: ['users.manage'] }, route: '/admin/approvals' });

    fireEvent.click(await screen.findByRole('button', { name: /approve bob@x\.com/i }));

    expect(await screen.findByText(/admin.*(fully or not at all|pairs)/i)).toBeInTheDocument();
    expect(screen.queryByText('admin_pair')).not.toBeInTheDocument();
  });

  it('approves with selected role_ids', async () => {
    installApprovalsHandlers();
    let approveBody: { role_ids?: unknown } | null = null;
    server.use(
      http.post('/api/admin/users/u1/approve', async ({ request }) => {
        approveBody = (await request.json()) as { role_ids?: unknown };
        return HttpResponse.json({ status: 'approved' });
      }),
    );

    renderWithProviders(<ApprovalsPage />, { me: { permissions: ['users.manage'] }, route: '/admin/approvals' });

    fireEvent.click(await screen.findByLabelText('member'));
    fireEvent.click(screen.getByRole('button', { name: /approve bob@x\.com/i }));

    await waitFor(() => expect(approveBody).toEqual({ role_ids: ['r1'] }));
  });
});
