import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../test/util';
import { AskPage } from './AskPage';
import * as sse from '../lib/sse';
import { ApiError } from '../lib/api';
import { ERROR_COPY } from '../lib/error-copy';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function installConversationHandlers() {
  server.use(
    http.get('/api/chat/conversations', () => HttpResponse.json([])),
    http.post('/api/chat/conversations', () => HttpResponse.json({ id: 'c1' })),
    http.get('/api/chat/conversations/c1', () =>
      HttpResponse.json({ id: 'c1', title: 'New chat', messages: [] }),
    ),
  );
}

async function renderAndCreateConversation() {
  installConversationHandlers();
  renderWithProviders(<AskPage />, {
    me: { permissions: ['prd.read', 'prd.ask'] },
    route: '/ask',
  });

  fireEvent.click(await screen.findByRole('button', { name: /new conversation/i }));
  await screen.findByRole('textbox', { name: /message/i });
}

describe('AskPage', () => {
  it('streams tokens and shows sources', async () => {
    vi.spyOn(sse, 'streamChat').mockImplementation(async (_convId, _content, handlers) => {
      handlers.onRewrite?.('q');
      handlers.onSources?.({
        sources: [{ id: 'EP-457', title: 'Referral', source_url: '', obsidian_link: '[[EP-457]]' }],
        verdict: 'match',
      });
      handlers.onToken('Refer');
      handlers.onToken('rals are…');
      handlers.onDone?.('42');
    });

    await renderAndCreateConversation();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'what about referrals?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText(/Referrals are…/)).toBeInTheDocument();
    expect(screen.getByText('EP-457')).toBeInTheDocument();
  });

  it('disables Send while streaming and requires a new message after', async () => {
    let resolveStream: (() => void) | undefined;
    vi.spyOn(sse, 'streamChat').mockImplementation(
      (_convId, _content, handlers) =>
        new Promise<void>((resolve) => {
          resolveStream = () => {
            handlers.onToken('done');
            handlers.onDone?.('1');
            resolve();
          };
        }),
    );

    await renderAndCreateConversation();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeDisabled());
    act(() => {
      resolveStream?.();
    });
    expect(await screen.findByText(/done/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeDisabled());
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'next question' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
  });

  it('shows friendly busy message on 409', async () => {
    vi.spyOn(sse, 'streamChat').mockRejectedValue(new ApiError('conversation_busy', 'busy', 409));

    await renderAndCreateConversation();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(
      await screen.findByText('A response is already being generated in this conversation.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('conversation_busy')).not.toBeInTheDocument();
  });

  it('shows friendly busy message from stream onError and requires a new message', async () => {
    vi.spyOn(sse, 'streamChat').mockImplementation(async (_convId, _content, handlers) => {
      handlers.onError?.('conversation_busy');
    });

    await renderAndCreateConversation();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(
      await screen.findByText('A response is already being generated in this conversation.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeDisabled());
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'retry' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
  });

  it('shows default copy for unknown stream onError strings', async () => {
    vi.spyOn(sse, 'streamChat').mockImplementation(async (_convId, _content, handlers) => {
      handlers.onError?.('generation failed');
    });

    await renderAndCreateConversation();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText(ERROR_COPY.default)).toBeInTheDocument();
    expect(screen.queryByText('generation failed')).not.toBeInTheDocument();
  });

  it('drops local streamed turn once the assistant message persists', async () => {
    let persisted = false;
    let detailRequests = 0;
    server.use(
      http.get('/api/chat/conversations', () =>
        HttpResponse.json([{ id: 'c1', title: 'Existing chat', updated_at: '2026-06-24T00:00:00Z' }]),
      ),
      http.get('/api/chat/conversations/c1', () => {
        detailRequests += 1;
        return HttpResponse.json({
          id: 'c1',
          title: 'Existing chat',
          messages: persisted
            ? [
                {
                  seq: 42,
                  role: 'assistant',
                  content: 'Answer',
                  sources: [],
                  grounded: true,
                  finish_reason: 'complete',
                },
                {
                  seq: 41,
                  role: 'user',
                  content: 'q',
                  sources: [],
                  grounded: true,
                  finish_reason: 'complete',
                },
              ]
            : [],
        });
      }),
    );
    vi.spyOn(sse, 'streamChat').mockImplementation(async (_convId, _content, handlers) => {
      handlers.onToken('Answer');
      persisted = true;
      handlers.onDone?.('42');
    });

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    const conversationButtons = await screen.findAllByRole('button', { name: /existing chat/i });
    fireEvent.click(conversationButtons[0]);
    const box = await screen.findByRole('textbox', { name: /message/i });
    fireEvent.change(box, { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await screen.findByText('q');
    await waitFor(() => expect(detailRequests).toBeGreaterThanOrEqual(2));
    expect(screen.getAllByText('Answer')).toHaveLength(1);
  });

  it('multi-turn re-retrieves and keeps per-turn sources', async () => {
    const calls: string[] = [];
    vi.spyOn(sse, 'streamChat').mockImplementation(async (_convId, content, handlers) => {
      calls.push(content);
      handlers.onSources?.({
        sources: [{ id: `EP-${calls.length}`, title: `T${calls.length}`, source_url: '', obsidian_link: '' }],
        verdict: 'match',
      });
      handlers.onToken(`answer ${calls.length}`);
      handlers.onDone?.(String(calls.length));
    });

    await renderAndCreateConversation();
    const box = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText('answer 1')).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText('answer 2')).toBeInTheDocument();

    expect(calls).toEqual(['first', 'second']);
    expect(screen.getByText('EP-1')).toBeInTheDocument();
    expect(screen.getByText('EP-2')).toBeInTheDocument();
  });
});
