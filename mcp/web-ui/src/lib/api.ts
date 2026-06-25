export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NO_BODY_STATUSES = new Set([204, 205, 304]);

export async function apiFetch<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (MUTATING_METHODS.has(method.toUpperCase())) {
    headers['X-Requested-With'] = 'prd-app';

    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const resp = await fetch(`/api${normalizedPath}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (NO_BODY_STATUSES.has(resp.status)) {
    return undefined as T;
  }

  const body = await resp.text();
  if (body === '') {
    if (!resp.ok) {
      throw new ApiError('http_error', resp.statusText, resp.status);
    }

    return undefined as T;
  }

  let data: { error?: { code?: string; message?: string } } | unknown;

  try {
    data = JSON.parse(body) as unknown;
  } catch {
    if (!resp.ok) {
      throw new ApiError('http_error', resp.statusText, resp.status);
    }

    throw new ApiError('invalid_response', 'malformed response body', resp.status);
  }

  if (!resp.ok) {
    const error = hasErrorEnvelope(data)
      ? data.error
      : { code: 'http_error', message: resp.statusText };
    throw new ApiError(error.code, error.message, resp.status);
  }

  return data as T;
}

function hasErrorEnvelope(value: unknown): value is { error: { code: string; message: string } } {
  if (!value || typeof value !== 'object' || !('error' in value)) {
    return false;
  }

  const error = (value as { error: unknown }).error;
  return (
    !!error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}
