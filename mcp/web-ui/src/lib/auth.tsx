import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError, apiFetch } from './api';

export interface RoleBrief {
  id: string;
  name: string;
}

export interface Me {
  id: string;
  email: string;
  status: string;
  roles: RoleBrief[];
  permissions: string[];
  created_at: string;
}

// oxlint-disable-next-line react/only-export-components -- required shared context export for auth hooks.
export const AuthContext = createContext<Me | null>(null);

// oxlint-disable-next-line react/only-export-components
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
    return false;
  }

  return failureCount < 2;
}

// oxlint-disable-next-line react/only-export-components -- hook export is required by the auth module contract.
export function useMe() {
  return useQuery<Me, ApiError>({
    queryKey: ['me'],
    queryFn: () => apiFetch<Me>('/auth/me'),
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });
}

export function AuthProvider({
  children,
  fallback,
  onUnauthenticated,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  onUnauthenticated?: ReactNode;
}): ReactNode {
  const { data, isError, isLoading } = useMe();

  if (isLoading) {
    return fallback ?? null;
  }

  if (isError || !data) {
    return onUnauthenticated ?? null;
  }

  return <AuthContext.Provider value={data}>{children}</AuthContext.Provider>;
}

/**
 * Returns the authenticated user. MUST be called only from components rendered inside
 * AuthProvider's success tree (i.e. its children). Throws if used outside the provider;
 * do NOT call it from a fallback or onUnauthenticated node which render OUTSIDE the context.
 */
// oxlint-disable-next-line react/only-export-components -- hook export is required by the auth module contract.
export function useAuth(): Me {
  const me = useContext(AuthContext);

  if (!me) {
    throw new Error('useAuth must be used inside AuthProvider');
  }

  return me;
}

/**
 * Returns whether the current user holds the given permission name. Safe to call anywhere;
 * returns false when there is no authenticated user (e.g. outside the provider).
 * Defense-in-depth only; the API still enforces.
 */
// oxlint-disable-next-line react/only-export-components -- hook export is required by the auth module contract.
export function useHasPermission(name: string): boolean {
  const me = useContext(AuthContext);

  return !!me && me.permissions.includes(name);
}
