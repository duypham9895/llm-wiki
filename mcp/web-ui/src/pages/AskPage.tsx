import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageSquarePlus, Send, Trash2 } from 'lucide-react';

import { ApiError, apiFetch } from '../lib/api';
import { copyForError } from '../lib/error-copy';
import { cn } from '../lib/utils';
import { streamChat } from '../lib/sse';

type ConversationSummary = {
  id: string;
  title: string;
  updated_at: string;
};

type PersistedMessage = {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  sources: unknown;
  grounded: boolean;
  finish_reason: string;
};

type ConversationDetail = {
  id: string;
  title: string;
  messages: PersistedMessage[];
};

type ChatSource = {
  id: string;
  title: string;
  source_url: string;
  obsidian_link: string;
};

type SourcesPayload = {
  sources: ChatSource[];
  verdict: string;
};

type LocalMessage = {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  content: string;
  seq?: string;
  rewrite?: string;
  sources?: SourcesPayload;
};

type RenderMessage = { id: string; role: 'user' | 'assistant'; content: string; rewrite?: string; sources?: SourcesPayload };

const CONVERSATIONS_KEY = ['chat-conversations'] as const;

export function AskPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const turnCounterRef = useRef(0);

  const conversationsQuery = useQuery({
    queryKey: CONVERSATIONS_KEY,
    queryFn: ({ signal }) => apiFetch<ConversationSummary[]>('/chat/conversations', { signal }),
  });

  const detailQuery = useQuery({
    queryKey: ['chat-conversation', selectedId],
    queryFn: ({ signal }) => apiFetch<ConversationDetail>(`/chat/conversations/${encodeURIComponent(selectedId ?? '')}`, { signal }),
    enabled: selectedId !== null,
  });

  const createConversation = useMutation({
    mutationFn: () => apiFetch<{ id: string }>('/chat/conversations', { method: 'POST' }),
    onSuccess: async (data) => {
      setSelectedId(data.id);
      await queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });

  const deleteConversation = useMutation({
    mutationFn: (conversationId: string) =>
      apiFetch<void>(`/chat/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }),
    onSuccess: async (_data, conversationId) => {
      if (selectedId === conversationId) {
        setSelectedId(null);
      }
      await queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
        return;
      }
      setError(copyForError(err));
    },
  });

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setError(null);
    setInput('');
    setLocalMessages([]);
  }, [selectedId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const persistedAssistantSeqs = new Set(
      detailQuery.data?.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => String(message.seq)) ?? [],
    );
    if (persistedAssistantSeqs.size === 0) return;

    setLocalMessages((current) => {
      const syncedTurns = new Set(
        current
          .filter((message) => message.role === 'assistant' && message.seq && persistedAssistantSeqs.has(message.seq))
          .map((message) => message.turnId),
      );
      if (syncedTurns.size === 0) return current;
      return current.filter((message) => !syncedTurns.has(message.turnId));
    });
  }, [detailQuery.data?.messages]);

  const renderedMessages = useMemo<RenderMessage[]>(() => {
    const persisted = (detailQuery.data?.messages ?? []).map((message): RenderMessage => ({
      id: `persisted-${message.seq}`,
      role: message.role,
      content: message.content,
      sources: message.role === 'assistant' ? normalizeSourcesPayload(message.sources) : undefined,
    }));
    const local = localMessages.map((message): RenderMessage => ({
      id: message.id,
      role: message.role,
      content: message.content,
      rewrite: message.rewrite,
      sources: message.sources,
    }));

    return [...persisted, ...local];
  }, [detailQuery.data?.messages, localMessages]);

  function finishGeneration(controller: AbortController) {
    if (abortRef.current !== controller) return;
    abortRef.current = null;
    setIsStreaming(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || isStreaming) return;

    const content = input.trim();
    if (!content) return;

    const turnId = `turn-${turnCounterRef.current + 1}`;
    turnCounterRef.current += 1;
    const assistantId = `${turnId}-assistant`;
    const controller = new AbortController();

    setInput('');
    setError(null);
    setIsStreaming(true);
    abortRef.current = controller;
    setLocalMessages((current) => [
      ...current,
      { id: `${turnId}-user`, turnId, role: 'user', content },
      { id: assistantId, turnId, role: 'assistant', content: '' },
    ]);

    try {
      await streamChat(
        selectedId,
        content,
        {
          onRewrite: (rewrite) => {
            if (abortRef.current !== controller) return;
            setLocalMessages((current) =>
              current.map((message) => (message.id === assistantId ? { ...message, rewrite } : message)),
            );
          },
          onSources: (payload) => {
            if (abortRef.current !== controller) return;
            setLocalMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, sources: normalizeSourcesPayload(payload) ?? undefined } : message,
              ),
            );
          },
          onToken: (token) => {
            if (abortRef.current !== controller) return;
            setLocalMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, content: `${message.content}${token}` } : message,
              ),
            );
          },
          onDone: (seq) => {
            if (abortRef.current !== controller) return;
            setLocalMessages((current) =>
              current.map((message) => (message.id === assistantId ? { ...message, seq } : message)),
            );
            finishGeneration(controller);
            void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
            void queryClient.invalidateQueries({ queryKey: ['chat-conversation', selectedId] });
          },
          onError: (m) => {
            if (abortRef.current !== controller) return;
            setError(copyForError(m));
            finishGeneration(controller);
          },
        },
        controller.signal,
      );
    } catch (err) {
      if (!isAbortError(err) && abortRef.current === controller) {
        setError(copyForError(err));
      }
    } finally {
      finishGeneration(controller);
    }
  }

  const conversations = conversationsQuery.data ?? [];
  const hasNoConversations = conversationsQuery.isSuccess && conversations.length === 0;
  const canSend = selectedId !== null && !isStreaming;

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">PRD assistant</p>
        <h1 className="text-2xl font-semibold tracking-normal">Ask</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <aside className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Conversations</h2>
            <button
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
              disabled={createConversation.isPending || isStreaming}
              type="button"
              onClick={() => createConversation.mutate()}
            >
              {createConversation.isPending ? <Loader2 className="size-4 animate-spin" /> : <MessageSquarePlus className="size-4" />}
              New conversation
            </button>
          </div>

          {conversationsQuery.isLoading ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading conversations.
            </p>
          ) : null}
          {conversationsQuery.isError ? <p className="mt-4 text-sm text-destructive">Could not load conversations.</p> : null}
          {hasNoConversations ? (
            <p className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No conversations yet. Create one to start asking.
            </p>
          ) : null}

          {conversations.length > 0 ? (
            <div className="mt-4 space-y-2">
              {conversations.map((conversation) => (
                <div key={conversation.id} className="flex items-center gap-2">
                  <button
                    className={cn(
                      'min-w-0 flex-1 rounded-md px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                      selectedId === conversation.id && 'bg-accent text-accent-foreground',
                    )}
                    type="button"
                    onClick={() => setSelectedId(conversation.id)}
                  >
                    <span className="block truncate font-medium">{conversation.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{formatDate(conversation.updated_at)}</span>
                  </button>
                  <button
                    aria-label={`Delete ${conversation.title}`}
                    className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-60"
                    disabled={deleteConversation.isPending || isStreaming}
                    type="button"
                    onClick={() => deleteConversation.mutate(conversation.id)}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </aside>

        <div className="min-h-[32rem] rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          {selectedId === null ? (
            <div className="grid min-h-[28rem] place-items-center rounded-md border border-dashed p-8 text-center">
              <div>
                <h2 className="text-lg font-semibold">Select or create a conversation.</h2>
                <p className="mt-2 text-sm text-muted-foreground">Ask questions after choosing a thread.</p>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[28rem] flex-col gap-4">
              <div className="flex items-start justify-between gap-4 border-b pb-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Thread</p>
                  <h2 className="text-lg font-semibold">{detailQuery.data?.title ?? 'Conversation'}</h2>
                </div>
                {detailQuery.isFetching ? <Loader2 className="mt-1 size-4 animate-spin text-muted-foreground" /> : null}
              </div>

              {detailQuery.isError ? <p className="text-sm text-destructive">Could not load this conversation.</p> : null}

              <div className="flex-1 space-y-4">
                {renderedMessages.length === 0 && !detailQuery.isLoading ? (
                  <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No messages yet. Send a question to start the thread.
                  </div>
                ) : null}
                {renderedMessages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
              </div>

              {error ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <form className="grid gap-3 border-t pt-4" onSubmit={handleSubmit}>
                <label className="grid gap-1 text-sm font-medium">
                  Message
                  <textarea
                    aria-label="Message"
                    className="min-h-24 resize-y rounded-md border border-input bg-background p-3 text-sm disabled:opacity-60"
                    disabled={isStreaming}
                    placeholder="Ask about a PRD"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                  />
                </label>
                <div className="flex justify-end">
                  <button
                    className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
                    disabled={!canSend}
                    type="submit"
                  >
                    {isStreaming ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                    Send
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function MessageBubble({ message }: { message: RenderMessage }) {
  const isAssistant = message.role === 'assistant';

  return (
    <article className={cn('rounded-lg border p-4', isAssistant ? 'bg-background' : 'bg-secondary/60')}>
      <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
        {isAssistant ? 'Assistant' : 'You'}
      </p>
      {message.rewrite ? <p className="mt-2 text-xs text-muted-foreground">Rewritten question: {message.rewrite}</p> : null}
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{message.content}</p>
      {isAssistant && message.sources && message.sources.sources.length > 0 ? (
        <SourcesPanel payload={message.sources} />
      ) : null}
    </article>
  );
}

function SourcesPanel({ payload }: { payload: SourcesPayload }) {
  return (
    <div className="mt-4 rounded-md border bg-muted/50 p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Sources</h3>
        {payload.verdict ? (
          <span className="rounded-full border px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
            {payload.verdict.replace('_', ' ')}
          </span>
        ) : null}
      </div>
      <ul className="mt-3 space-y-2">
        {payload.sources.map((source) => (
          <li key={`${source.id}-${source.title}`} className="text-sm">
            <span className="font-medium">{source.id}</span>
            {source.title ? <span className="text-muted-foreground"> · {source.title}</span> : null}
            <div className="mt-1 flex flex-wrap gap-3 text-xs font-medium text-primary">
              {source.source_url ? (
                <a href={source.source_url} rel="noreferrer" target="_blank">
                  Source
                </a>
              ) : null}
              {source.obsidian_link ? (
                <a href={source.obsidian_link} rel="noreferrer" target="_blank">
                  Obsidian
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function normalizeSourcesPayload(value: unknown): SourcesPayload | undefined {
  if (isSourcesEnvelope(value)) {
    return {
      verdict: value.verdict,
      sources: value.sources.map(normalizeSource),
    };
  }

  if (Array.isArray(value)) {
    return { verdict: '', sources: value.map(normalizeSource) };
  }

  return undefined;
}

function normalizeSource(value: unknown): ChatSource {
  if (!value || typeof value !== 'object') {
    return { id: '', title: '', source_url: '', obsidian_link: '' };
  }

  const record = value as Record<string, unknown>;
  return {
    id: readString(record.id),
    title: readString(record.title),
    source_url: readString(record.source_url),
    obsidian_link: readString(record.obsidian_link),
  };
}

function isSourcesEnvelope(value: unknown): value is { sources: unknown[]; verdict: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.sources) && typeof record.verdict === 'string';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function formatDate(value: string): string {
  if (!value) return 'Updated recently';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Updated recently';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
