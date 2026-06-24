import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { parseSSEChunk, streamChat } from './sse';

const encoder = new TextEncoder();

function streamResponse(chunks: string[], init?: ResponseInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    init,
  );
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

function byteStreamResponse(chunks: Uint8Array[], init?: ResponseInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    init,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSSEChunk', () => {
  it('parses LF frames and returns a partial remainder', () => {
    const result = parseSSEChunk('event: token\ndata: hello\n\nevent: done\ndata: 9');

    expect(result.events).toEqual([{ event: 'token', data: 'hello' }]);
    expect(result.rest).toBe('event: done\ndata: 9');
  });

  it('parses CRLF frames', () => {
    const result = parseSSEChunk('event: token\r\ndata: hi\r\n\r\n');

    expect(result.events).toEqual([{ event: 'token', data: 'hi' }]);
    expect(result.rest).toBe('');
  });

  it('reassembles a frame split across two chunks via rest', () => {
    const first = parseSSEChunk('event: token\ndata: hel');
    const second = parseSSEChunk(`${first.rest}lo\n\n`);

    expect(first.events).toEqual([]);
    expect(first.rest).toBe('event: token\ndata: hel');
    expect(second.events).toEqual([{ event: 'token', data: 'hello' }]);
    expect(second.rest).toBe('');
  });

  it('preserves colons inside data values', () => {
    const result = parseSSEChunk('event: token\ndata: value: still data\n\n');

    expect(result.events).toEqual([{ event: 'token', data: 'value: still data' }]);
  });

  it('joins multiple data lines with newlines', () => {
    const result = parseSSEChunk('event: token\ndata: first\ndata: second\n\n');

    expect(result.events).toEqual([{ event: 'token', data: 'first\nsecond' }]);
  });

  it('returns all input as rest when no complete frame exists', () => {
    const input = 'event: token\ndata: pending';

    expect(parseSSEChunk(input)).toEqual({ events: [], rest: input });
  });

  it('ignores comment and heartbeat frames', () => {
    const result = parseSSEChunk(': heartbeat\n\nevent: token\ndata: ok\n\n');

    expect(result.events).toEqual([{ event: 'token', data: 'ok' }]);
  });

  it('emits empty data tokens when a data line exists', () => {
    const result = parseSSEChunk('event: token\ndata:\n\n');

    expect(result.events).toEqual([{ event: 'token', data: '' }]);
  });

  it('parses bare CR frames and separators', () => {
    const result = parseSSEChunk('event: token\rdata: a\r\rdata: b\r\r');

    expect(result.events).toEqual([
      { event: 'token', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
    expect(result.rest).toBe('');
  });
});

describe('streamChat', () => {
  it('throws ApiError with envelope code and status on non-ok JSON responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      textResponse(JSON.stringify({ error: { code: 'conversation_busy', message: 'busy' } }), {
        status: 409,
        statusText: 'Conflict',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const err = await streamChat('c1', 'hi', { onToken: vi.fn() }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'conversation_busy',
      status: 409,
    });
  });

  it('throws http_error ApiError on non-ok non-JSON responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      textResponse('<html></html>', { status: 500, statusText: 'Server Error' }),
    );

    await expect(streamChat('c1', 'hi', { onToken: vi.fn() })).rejects.toBeInstanceOf(ApiError);
    await expect(streamChat('c1', 'hi', { onToken: vi.fn() })).rejects.toMatchObject({
      code: 'http_error',
      status: 500,
    });
  });

  it('reassembles a token split across stream chunks and dispatches done', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      streamResponse(['event: token\ndata: hel', 'lo\n\nevent: done\ndata: 42\n\n']),
    );
    const tokens: string[] = [];
    const done = vi.fn();

    await streamChat('c1', 'hi', { onToken: (token) => tokens.push(token), onDone: done });

    expect(tokens).toEqual(['hello']);
    expect(done).toHaveBeenCalledWith('42');
  });

  it('dispatches empty token events over the wire', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      streamResponse(['event: token\ndata:\n\nevent: done\ndata: done\n\n']),
    );
    const onToken = vi.fn();

    await streamChat('c1', 'hi', { onToken });

    expect(onToken).toHaveBeenCalledWith('');
  });

  it('preserves a multibyte UTF-8 token split across the final chunk boundary', async () => {
    const frame = encoder.encode('event: token\ndata: ✓\n\n');
    const splitAt = encoder.encode('event: token\ndata: ').length + 1;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      byteStreamResponse([frame.slice(0, splitAt), frame.slice(splitAt)]),
    );
    const onToken = vi.fn();

    await streamChat('c1', 'hi', { onToken });

    expect(onToken).toHaveBeenCalledWith('✓');
  });

  it('dispatches rewrite, parsed sources, tokens, and done in order', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      streamResponse([
        'event: rewrite\ndata: better question\n\n',
        'event: sources\ndata: {"sources":[{"id":1}],"verdict":"ok"}\n\n',
        'event: token\ndata: one\n\n',
        'event: token\ndata: two\n\n',
        'event: done\ndata: 17\n\n',
      ]),
    );
    const calls: string[] = [];

    await streamChat('c1', 'hi', {
      onRewrite: (question) => calls.push(`rewrite:${question}`),
      onSources: (payload) => calls.push(`sources:${payload.verdict}:${payload.sources.length}`),
      onToken: (token) => calls.push(`token:${token}`),
      onDone: (seq) => calls.push(`done:${seq}`),
    });

    expect(calls).toEqual([
      'rewrite:better question',
      'sources:ok:1',
      'token:one',
      'token:two',
      'done:17',
    ]);
  });

  it('dispatches error events without calling done', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      streamResponse(['event: error\ndata: boom\n\n']),
    );
    const onError = vi.fn();
    const onDone = vi.fn();

    await streamChat('c1', 'hi', { onToken: vi.fn(), onError, onDone });

    expect(onError).toHaveBeenCalledWith('boom');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('survives malformed sources payloads and keeps dispatching later events', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      streamResponse([
        'event: sources\ndata: nope\n\n',
        'event: token\ndata: after\n\n',
        'event: done\ndata: 21\n\n',
      ]),
    );
    const onError = vi.fn();
    const onToken = vi.fn();
    const onDone = vi.fn();

    await streamChat('c1', 'hi', { onToken, onError, onDone });

    expect(onError).toHaveBeenCalledWith('malformed sources payload');
    expect(onToken).toHaveBeenCalledWith('after');
    expect(onDone).toHaveBeenCalledWith('21');
  });

  it('rejects with AbortError mid-stream after dispatching pre-abort tokens', async () => {
    const abortController = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode('event: token\ndata: before\n\n'));
            abortController.signal.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        }),
      ),
    );
    const tokens: string[] = [];

    const err = await streamChat(
      'c1',
      'hi',
      {
        onToken: (token) => {
          tokens.push(token);
          abortController.abort();
        },
      },
      abortController.signal,
    ).catch((e) => e);

    expect(tokens).toEqual(['before']);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(streamController).not.toBeNull();
  });

  it('sends CSRF header, encoded conversation id, POST method, and same-origin credentials', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(streamResponse(['event: done\ndata: 1\n\n']));

    await streamChat('a/b', 'hello', { onToken: vi.fn() });

    expect(fetchSpy).toHaveBeenCalledWith('/api/chat/conversations/a%2Fb/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'prd-app',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ content: 'hello' }),
      signal: undefined,
    });
  });
});
