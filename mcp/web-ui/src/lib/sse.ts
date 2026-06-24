import { ApiError } from './api';

export interface ChatHandlers {
  onRewrite?(q: string): void;
  onSources?(p: { sources: unknown[]; verdict: string }): void;
  onToken(t: string): void;
  onDone?(seq: string): void;
  onError?(m: string): void;
}

export function parseSSEChunk(buffer: string): {
  events: { event: string; data: string }[];
  rest: string;
} {
  const pieces = buffer.split(/\r\n\r\n|\n\n|\r\r/);
  const rest = pieces.at(-1) ?? '';
  const frames = pieces.slice(0, -1);
  const events: { event: string; data: string }[] = [];

  for (const frame of frames) {
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of frame.split(/\r\n|\n|\r/)) {
      if (line.startsWith(':')) {
        continue;
      }

      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }

    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') });
    }
  }

  return { events, rest };
}

export async function streamChat(
  convId: string,
  content: string,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(`/api/chat/conversations/${encodeURIComponent(convId)}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'prd-app',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ content }),
    signal,
  });

  if (!resp.ok) {
    throw await readApiError(resp);
  }

  if (!resp.body) {
    throw new ApiError('no_body', 'Response has no body', resp.status);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      const parsed = parseSSEChunk(buffer);
      buffer = parsed.rest;

      for (const event of parsed.events) {
        dispatchEvent(event, handlers);
      }

      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readApiError(resp: Response): Promise<ApiError> {
  try {
    const payload = (await resp.json()) as unknown;
    if (hasErrorEnvelope(payload)) {
      return new ApiError(payload.error.code, payload.error.message, resp.status);
    }
  } catch {
    // Fall through to the generic HTTP error below.
  }

  return new ApiError('http_error', resp.statusText, resp.status);
}

function dispatchEvent(event: { event: string; data: string }, handlers: ChatHandlers): void {
  switch (event.event) {
    case 'rewrite':
      handlers.onRewrite?.(event.data);
      break;
    case 'sources':
      try {
        const payload = JSON.parse(event.data) as { sources: unknown[]; verdict: string };
        handlers.onSources?.(payload);
      } catch {
        handlers.onError?.('malformed sources payload');
      }
      break;
    case 'token':
      handlers.onToken(event.data);
      break;
    case 'done':
      handlers.onDone?.(event.data);
      break;
    case 'error':
      handlers.onError?.(event.data);
      break;
  }
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
