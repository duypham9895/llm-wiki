import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { ApiError, apiFetch } from './api';

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('apiFetch', () => {
  it('parses JSON on success', async () => {
    server.use(http.get('/api/ping', () => HttpResponse.json({ ok: true })));

    await expect(apiFetch('/ping')).resolves.toEqual({ ok: true });
  });

  it('sends the CSRF header and credentials on mutating requests', async () => {
    let seen: Request | null = null;

    server.use(
      http.post('/api/anything', ({ request }) => {
        seen = request;
        return HttpResponse.json({ ok: true });
      }),
    );

    await apiFetch('/anything', { method: 'POST', body: { a: 1 } });

    expect(seen).not.toBeNull();
    expect(seen!.headers.get('x-requested-with')).toBe('prd-app');
    expect(seen!.credentials).toBe('same-origin');
  });

  it('throws ApiError with code and status from the error envelope', async () => {
    server.use(
      http.get('/api/bad', () =>
        HttpResponse.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 }),
      ),
    );

    await expect(apiFetch('/bad')).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch('/bad')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('resolves no-content responses to undefined', async () => {
    server.use(http.delete('/api/session', () => new HttpResponse(null, { status: 204 })));

    await expect(apiFetch('/session', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('throws http_error for non-JSON error responses', async () => {
    server.use(http.get('/api/html-error', () => HttpResponse.text('<html></html>', { status: 500 })));

    await expect(apiFetch('/html-error')).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch('/html-error')).rejects.toMatchObject({ code: 'http_error', status: 500 });
  });

  it('throws http_error when JSON error response lacks an error envelope', async () => {
    server.use(http.get('/api/detail-error', () => HttpResponse.json({ detail: 'x' }, { status: 422 })));

    await expect(apiFetch('/detail-error')).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch('/detail-error')).rejects.toMatchObject({ code: 'http_error', status: 422 });
  });

  it('throws invalid_response for malformed successful JSON responses', async () => {
    server.use(http.get('/api/malformed', () => HttpResponse.text('{', { status: 200 })));

    await expect(apiFetch('/malformed')).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch('/malformed')).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    });
  });

  it('normalizes paths without a leading slash', async () => {
    server.use(http.get('/api/ping', () => HttpResponse.json({ ok: true })));

    await expect(apiFetch('ping')).resolves.toEqual({ ok: true });
  });
});
