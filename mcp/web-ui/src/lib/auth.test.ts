import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { shouldRetry, useAuth, useHasPermission } from './auth';

describe('shouldRetry', () => {
  it('returns false for 401 API errors', () => {
    expect(shouldRetry(0, new ApiError('unauthorized', 'unauthorized', 401))).toBe(false);
  });

  it('returns false for 403 API errors', () => {
    expect(shouldRetry(0, new ApiError('forbidden', 'forbidden', 403))).toBe(false);
  });

  it('returns false for 404 API errors', () => {
    expect(shouldRetry(0, new ApiError('not_found', 'not found', 404))).toBe(false);
  });

  it('retries server errors only for the first two failures', () => {
    const err = new ApiError('server_error', 'server error', 500);

    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(1, err)).toBe(true);
    expect(shouldRetry(2, err)).toBe(false);
  });

  it('retries network errors only for the first two failures', () => {
    const err = new Error('network');

    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(1, err)).toBe(true);
    expect(shouldRetry(2, err)).toBe(false);
  });
});

describe('auth hooks outside provider', () => {
  it('throws from useAuth outside AuthProvider', () => {
    const { result } = renderHook(() => {
      try {
        useAuth();
      } catch (err) {
        return { error: err };
      }

      return { error: undefined };
    });

    expect(result.current.error).toBeDefined();
  });

  it('returns false from useHasPermission outside AuthProvider', () => {
    const { result } = renderHook(() => useHasPermission('admin'));

    expect(result.current).toBe(false);
  });
});
