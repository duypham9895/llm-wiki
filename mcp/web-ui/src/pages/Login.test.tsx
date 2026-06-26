import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';

import { Login } from './Login';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderLogin(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={children} />
            <Route path="/library" element={<p>Library route</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  return {
    queryClient,
    ...render(ui, { wrapper: Wrapper }),
  };
}

describe('Login', () => {
  it('shows the generic error on bad credentials without account enumeration', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json({ error: { code: 'invalid_credentials', message: 'x' } }, { status: 401 }),
      ),
    );

    renderLogin(<Login />);

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'who@ringkas.co.id' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/email or password is incorrect/i)).toBeInTheDocument();
    expect(screen.queryByText(/no account|not found|unknown user|no such/i)).not.toBeInTheDocument();
  });

  it('invalidates the current user query after successful login', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json({
          user: {
            id: 'u1',
            email: 'a@b.co',
            status: 'active',
            roles: [],
            permissions: ['prd.read'],
            created_at: '2026-06-24T00:00:00Z',
          },
        }),
      ),
    );
    const { queryClient } = renderLogin(<Login />);
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'correct' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['me'] });
    });
    expect(await screen.findByText('Library route')).toBeInTheDocument();
  });
});
