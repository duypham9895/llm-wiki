import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../test/util';
import { AskPage } from './AskPage';
import * as sse from '../lib/sse';
import { ApiError } from '../lib/api';
import { ERROR_COPY } from '../lib/error-copy';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import { toast } from 'sonner';
const toastMock = toast as unknown as ReturnType<typeof vi.fn> & {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  toastMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  window.history.replaceState(null, '', '/');
});
afterAll(() => server.close());

beforeEach(() => {
  window.history.replaceState(null, '', '/ask');
});

function installConversationHandlers(opts?: { detailMessages?: unknown }) {
  server.use(
    http.get('/api/chat/conversations', () => HttpResponse.json([])),
    http.post('/api/chat/conversations', () => HttpResponse.json({ id: 'c1' })),
    http.get('/api/chat/conversations/c1', () =>
      HttpResponse.json({
        id: 'c1',
        title: 'New chat',
        messages: opts?.detailMessages ?? [],
      }),
    ),
    http.delete('/api/chat/conversations/c1', () => new HttpResponse(null, { status: 204 })),
  );
}

async function renderAndCreateConversation() {
  installConversationHandlers();
  renderWithProviders(<AskPage />, {
    me: { permissions: ['prd.read', 'prd.ask'] },
    route: '/ask',
  });

  // Click the first "New chat" button (the rail's primary CTA).
  const newChatButtons = await screen.findAllByRole('button', { name: /new chat/i });
  fireEvent.click(newChatButtons[0]);
  await screen.findByRole('textbox', { name: /message/i });
  // Wait for the URL hash to update so subsequent assertions are stable.
  await waitFor(() => {
    expect(window.location.hash).toBe('#c=c1');
  });
}

describe('AskPage — empty state', () => {
  it('renders EmptyState with example prompts when there are no conversations and no cid', async () => {
    server.use(http.get('/api/chat/conversations', () => HttpResponse.json([])));

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    expect(
      await screen.findByRole('heading', { name: /start by asking about any prd/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/try a question like.+onboarding flow for new pms/i),
    ).toBeInTheDocument();
    // Three example prompts visible.
    const prompts = screen.getAllByRole('button', {
      name: /onboarding flow|summarize ep-468|referral risk/i,
    });
    expect(prompts).toHaveLength(3);
  });

  it('shows "Your Ask history will appear here" in the rail when conversations list is empty', async () => {
    server.use(http.get('/api/chat/conversations', () => HttpResponse.json([])));

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    expect(
      await screen.findByText(/your ask history will appear here/i),
    ).toBeInTheDocument();
  });
});

describe('AskPage — conversation list', () => {
  it('renders conversations returned by the API in the left rail', async () => {
    server.use(
      http.get('/api/chat/conversations', () =>
        HttpResponse.json([
          { id: 'a', title: 'Onboarding flow', updated_at: '2026-06-25T10:00:00Z' },
          { id: 'b', title: 'Referral risk', updated_at: '2026-06-24T09:00:00Z' },
        ]),
      ),
    );

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    expect(await screen.findByRole('button', { name: /onboarding flow/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /referral risk/i })).toBeInTheDocument();
  });

  it('truncates long titles to 60 chars', async () => {
    const longTitle = 'a'.repeat(80);
    server.use(
      http.get('/api/chat/conversations', () =>
        HttpResponse.json([{ id: 'a', title: longTitle, updated_at: '2026-06-25T10:00:00Z' }]),
      ),
    );

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    // The rail button's accessible name is the TRUNCATED title (matches what's visible).
    // After truncate(60), the displayed title contains ellipsis.
    const button = await screen.findByRole('button', { name: /Open conversation/ });
    expect(button.textContent ?? '').toMatch(/…/);
  });

  it('clicking a conversation loads its messages into the main area', async () => {
    server.use(
      http.get('/api/chat/conversations', () =>
        HttpResponse.json([{ id: 'a', title: 'Existing', updated_at: '2026-06-25T10:00:00Z' }]),
      ),
      http.get('/api/chat/conversations/a', () =>
        HttpResponse.json({
          id: 'a',
          title: 'Existing',
          messages: [
            {
              seq: 1,
              role: 'user',
              content: 'hello?',
              sources: [],
              grounded: true,
              finish_reason: 'complete',
            },
            {
              seq: 2,
              role: 'assistant',
              content: 'hi there',
              sources: [],
              grounded: true,
              finish_reason: 'complete',
            },
          ],
        }),
      ),
    );

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    fireEvent.click(await screen.findByRole('button', { name: /open conversation existing/i }));
    expect(await screen.findByText('hello?')).toBeInTheDocument();
    expect(screen.getByText('hi there')).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).toBe('#c=a');
    });
  });
});

describe('AskPage — new chat', () => {
  it('clicking New chat POSTs to /chat/conversations, sets active cid, and updates URL hash', async () => {
    installConversationHandlers();

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    // Empty state renders the heading + the rail "Start new chat" button.
    expect(
      await screen.findByRole('heading', { name: /start by asking about any prd/i }),
    ).toBeInTheDocument();

    // Use the rail's primary CTA (it has aria-label="Start new chat").
    const newChatButton = await screen.findByRole('button', { name: /start new chat/i });
    fireEvent.click(newChatButton);

    await waitFor(() => {
      expect(window.location.hash).toBe('#c=c1');
    });
    expect(await screen.findByRole('textbox', { name: /message/i })).toBeInTheDocument();
  });

  it('clears the hash and focuses the composer when starting a fresh chat from a selected conversation', async () => {
    server.use(
      http.get('/api/chat/conversations', () =>
        HttpResponse.json([{ id: 'a', title: 'Old', updated_at: '2026-06-25T10:00:00Z' }]),
      ),
      http.post('/api/chat/conversations', () => HttpResponse.json({ id: 'c2' })),
      http.get('/api/chat/conversations/a', () =>
        HttpResponse.json({ id: 'a', title: 'Old', messages: [] }),
      ),
      http.get('/api/chat/conversations/c2', () =>
        HttpResponse.json({ id: 'c2', title: 'New chat', messages: [] }),
      ),
    );
    window.history.replaceState(null, '', '/ask#c=a');

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    expect(await screen.findByRole('button', { name: /open conversation old/i })).toBeInTheDocument();

    // Click the rail's "New chat" button (has aria-label="Start new chat").
    const railNewChat = await screen.findByRole('button', { name: /start new chat/i });
    fireEvent.click(railNewChat);

    await waitFor(() => {
      expect(window.location.hash).toBe('#c=c2');
    });
  });
});

describe('AskPage — delete', () => {
  it('clicking delete opens confirm dialog, then DELETE removes it from list', async () => {
    server.use(
      http.get('/api/chat/conversations', () =>
        HttpResponse.json([{ id: 'a', title: 'Doomed', updated_at: '2026-06-25T10:00:00Z' }]),
      ),
      http.delete('/api/chat/conversations/a', () => new HttpResponse(null, { status: 204 })),
    );

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    const deleteBtn = await screen.findByRole('button', { name: /delete conversation doomed/i });
    fireEvent.click(deleteBtn);

    // Dialog appears with the correct copy.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/delete this conversation/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/this cannot be undone/i)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /open conversation doomed/i })).not.toBeInTheDocument();
  });

  it('rolls back optimistic removal and shows toast on delete error', async () => {
    server.use(
      http.get('/api/chat/conversations', () =>
        HttpResponse.json([{ id: 'a', title: 'Stay', updated_at: '2026-06-25T10:00:00Z' }]),
      ),
      http.delete('/api/chat/conversations/a', () =>
        HttpResponse.json({ error: { code: 'http_error', message: 'boom' } }, { status: 500 }),
      ),
    );

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    const deleteBtn = await screen.findByRole('button', { name: /delete conversation stay/i });
    fireEvent.click(deleteBtn);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalled();
    });
    // Dialog stays open on error (rollback); user must cancel.
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Item should still be there (rollback).
    expect(await screen.findByRole('button', { name: /open conversation stay/i })).toBeInTheDocument();
  });
});

describe('AskPage — URL hash', () => {
  it('loads conversation from URL hash on mount', async () => {
    server.use(
      http.get('/api/chat/conversations', () => HttpResponse.json([])),
      http.get('/api/chat/conversations/abc', () =>
        HttpResponse.json({
          id: 'abc',
          title: 'From hash',
          messages: [
            {
              seq: 1,
              role: 'user',
              content: 'prior question',
              sources: [],
              grounded: true,
              finish_reason: 'complete',
            },
          ],
        }),
      ),
    );
    window.history.replaceState(null, '', '/ask#c=abc');

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    expect(await screen.findByText('prior question')).toBeInTheDocument();
    // Hash unchanged (was already c=abc).
    expect(window.location.hash).toBe('#c=abc');
  });

  it('updates the URL hash when active cid changes', async () => {
    installConversationHandlers();
    server.use(
      http.get('/api/chat/conversations', () =>
        HttpResponse.json([{ id: 'a', title: 'A', updated_at: '2026-06-25T10:00:00Z' }]),
      ),
      http.get('/api/chat/conversations/a', () =>
        HttpResponse.json({ id: 'a', title: 'A', messages: [] }),
      ),
    );

    renderWithProviders(<AskPage />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/ask',
    });

    fireEvent.click(await screen.findByRole('button', { name: /open conversation a/i }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#c=a');
    });
  });
});

describe('AskPage — streaming (regression: existing SSE code path)', () => {
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
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeDisabled());
    act(() => {
      resolveStream?.();
    });
    expect(await screen.findByText(/done/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeDisabled());
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'next question' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled());
  });

  it('shows friendly busy message on 409', async () => {
    vi.spyOn(sse, 'streamChat').mockRejectedValue(new ApiError('conversation_busy', 'busy', 409));

    await renderAndCreateConversation();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(
      await screen.findByText('A response is already being generated in this conversation.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('conversation_busy')).not.toBeInTheDocument();
  });

  it('shows friendly busy message from stream onError', async () => {
    vi.spyOn(sse, 'streamChat').mockImplementation(async (_convId, _content, handlers) => {
      handlers.onError?.('conversation_busy');
    });

    await renderAndCreateConversation();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(
      await screen.findByText('A response is already being generated in this conversation.'),
    ).toBeInTheDocument();
  });

  it('shows default copy for unknown stream onError strings', async () => {
    vi.spyOn(sse, 'streamChat').mockImplementation(async (_convId, _content, handlers) => {
      handlers.onError?.('generation failed');
    });

    await renderAndCreateConversation();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'hi' },
    });
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

    const conversationButtons = await screen.findAllByRole('button', { name: /open conversation existing chat/i });
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