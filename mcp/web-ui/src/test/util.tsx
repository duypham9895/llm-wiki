import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';

import { AuthProvider, type Me } from '../lib/auth';
import { ThemeProvider } from '../lib/theme';

type TestMe = Partial<Me> & Pick<Me, 'permissions'>;

export function makeMe(me: TestMe): Me {
  return {
    id: 'user-1',
    email: 'user@example.com',
    status: 'active',
    roles: [],
    created_at: '2026-06-24T00:00:00Z',
    ...me,
  };
}

export function renderWithProviders(
  ui: ReactElement,
  { me, route = '/', ...options }: { me: TestMe; route?: string } & Omit<RenderOptions, 'wrapper'>,
) {
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
        </QueryClientProvider>
      </ThemeProvider>
    );
  }

  return {
    queryClient,
    ...render(ui, { wrapper: Wrapper, ...options }),
  };
}
