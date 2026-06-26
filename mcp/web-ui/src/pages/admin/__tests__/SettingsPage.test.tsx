import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../../../test/util';
import { SettingsPage } from '../SettingsPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function installSettingsHandlers() {
  server.use(
    http.get('/api/admin/settings', () =>
      HttpResponse.json({ registration_enabled: false, allowed_domains: ['existing.com'] }),
    ),
  );
}

describe('SettingsPage', () => {
  it('saves registration and parsed allowed domains', async () => {
    installSettingsHandlers();
    let settingsBody: { registration_enabled?: unknown; allowed_domains?: unknown } | null = null;
    server.use(
      http.put('/api/admin/settings', async ({ request }) => {
        settingsBody = (await request.json()) as { registration_enabled?: unknown; allowed_domains?: unknown };
        return HttpResponse.json({ registration_enabled: true, allowed_domains: ['existing.com', 'a.com', 'b.com'] });
      }),
    );

    renderWithProviders(<SettingsPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/settings' });

    await screen.findByText('existing.com');
    const registrationToggle = screen.getByRole('checkbox', { name: /registration enabled/i });
    fireEvent.click(registrationToggle);
    expect(registrationToggle).toBeChecked();
    fireEvent.change(screen.getByLabelText(/domain/i), { target: { value: 'A.COM, b.com existing.com' } });
    fireEvent.click(screen.getByRole('button', { name: /add domain/i }));
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() =>
      expect(settingsBody).toEqual({
        registration_enabled: true,
        allowed_domains: ['existing.com', 'a.com', 'b.com'],
      }),
    );
    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
  });

  it('blocks save and shows a warning when registration is on with zero allowed domains', async () => {
    installSettingsHandlers();
    server.use(
      http.get('/api/admin/settings', () =>
        HttpResponse.json({ registration_enabled: true, allowed_domains: [] }),
      ),
    );
    const putCalls: Array<unknown> = [];
    server.use(
      http.put('/api/admin/settings', async ({ request }) => {
        putCalls.push(await request.json());
        return HttpResponse.json({ registration_enabled: true, allowed_domains: [] });
      }),
    );

    renderWithProviders(<SettingsPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/settings' });

    const saveButton = await screen.findByRole('button', { name: /save settings/i });
    await waitFor(() => expect(saveButton).toBeDisabled());
    expect(await screen.findByText(/add at least one allowed email domain before enabling registration/i)).toBeInTheDocument();

    // Force-click anyway: the onSubmit guard should still swallow it.
    fireEvent.click(saveButton);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(putCalls).toHaveLength(0);
  });
});
