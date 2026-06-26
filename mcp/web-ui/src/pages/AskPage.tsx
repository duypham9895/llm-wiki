import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/EmptyState';
import { MarkdownView } from '@/components/MarkdownView';
import { PageHeader } from '@/components/PageHeader';
import {
  ConversationList,
  type ConversationSummary,
} from '@/components/ConversationList';
import { ApiError, apiFetch } from '@/lib/api';
import { copyForError } from '@/lib/error-copy';
import { streamChat } from '@/lib/sse';

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

type RenderMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  rewrite?: string;
  sources?: SourcesPayload;
};

const CONVERSATIONS_KEY = ['chat-conversations'] as const;

const EXAMPLE_PROMPTS = [
  "What's our onboarding flow for new PMs?",
  'Summarize EP-468 (Onboarding Redesign).',
  'Which PRDs mention referral risk this quarter?',
];

function parseCidFromHash(hash: string): string | null {
  if (!hash || hash === '#') return null;
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(trimmed);
  const cid = params.get('c');
  return cid && cid.length > 0 ? cid : null;
}

function buildHashForCid(cid: string | null): string {
  return cid ? `#c=${encodeURIComponent(cid)}` : '';
}

export function AskPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnCounterRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // Read initial cid from URL hash on mount.
  useEffect(() => {
    const initial = parseCidFromHash(window.location.hash);
    if (initial) setSelectedId(initial);
  }, []);

  // Sync the URL hash whenever the active cid changes.
  useEffect(() => {
    const nextHash = buildHashForCid(selectedId);
    const currentHash = window.location.hash;
    if (nextHash !== currentHash) {
      window.history.replaceState(null, '', nextHash ? `/ask${nextHash}` : '/ask');
    }
  }, [selectedId]);

  // Cross-tab hash sync: if the user navigates via browser back/forward.
  useEffect(() => {
    function handleHashChange() {
      const next = parseCidFromHash(window.location.hash);
      setSelectedId(next);
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const conversationsQuery = useQuery({
    queryKey: CONVERSATIONS_KEY,
    queryFn: ({ signal }) => apiFetch<ConversationSummary[]>('/chat/conversations', { signal }),
  });

  const detailQuery = useQuery({
    queryKey: ['chat-conversation', selectedId],
    queryFn: ({ signal }) =>
      apiFetch<ConversationDetail>(`/chat/conversations/${encodeURIComponent(selectedId ?? '')}`, {
        signal,
      }),
    enabled: selectedId !== null,
  });

  const createConversation = useMutation({
    mutationFn: () => apiFetch<{ id: string }>('/chat/conversations', { method: 'POST' }),
    onSuccess: async (data) => {
      setSelectedId(data.id);
      setInput('');
      setError(null);
      queueMicrotask(() => composerRef.current?.focus());
      await queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
    onError: (err) => {
      toast.error(copyForError(err));
    },
  });

  const deleteConversation = useMutation({
    mutationFn: (conversationId: string) =>
      apiFetch<void>(`/chat/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'DELETE',
      }),
    onMutate: async (conversationId: string) => {
      // Optimistic remove from the list cache.
      await queryClient.cancelQueries({ queryKey: CONVERSATIONS_KEY });
      const previous = queryClient.getQueryData<ConversationSummary[]>(CONVERSATIONS_KEY);
      if (previous) {
        queryClient.setQueryData<ConversationSummary[]>(
          CONVERSATIONS_KEY,
          previous.filter((c) => c.id !== conversationId),
        );
      }
      return { previous };
    },
    onError: (err, _conversationId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(CONVERSATIONS_KEY, context.previous);
      }
      if (err instanceof ApiError && err.status === 404) {
        toast.success('Conversation already removed.');
      } else {
        toast.error(copyForError(err));
      }
    },
    onSuccess: async (_data, conversationId) => {
      if (selectedId === conversationId) {
        setSelectedId(null);
      }
      setPendingDeleteId(null);
      // Optimistic cache update already removed the row; skip the refetch so the
      // server mock (and stale state) doesn't bring it back. invalidate only on error.
    },
    onSettled: () => {
      // Always clear the pending state so the dialog closes, even when the
      // server returns an error (the rollback path in onError restores the cache).
      setPendingDeleteId(null);
    },
  });

  // Reset transient state when conversation changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setError(null);
    setInput('');
    setLocalMessages([]);
    queueMicrotask(() => composerRef.current?.focus());
  }, [selectedId]);

  // Cleanup any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Drop local streamed assistant messages once they're persisted server-side.
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

  const conversations = conversationsQuery.data ?? [];

  function handleNewChat() {
    if (createConversation.isPending) return;
    createConversation.mutate();
  }

  function handleSelect(cid: string) {
    setSelectedId(cid);
  }

  function handleRequestDelete(cid: string) {
    setPendingDeleteId(cid);
  }

  function handleCancelDelete() {
    setPendingDeleteId(null);
  }

  function handleConfirmDelete() {
    if (!pendingDeleteId) return;
    deleteConversation.mutate(pendingDeleteId);
  }

  function handleExamplePrompt(prompt: string) {
    if (!selectedId) {
      // No active conversation yet — create one first, then pre-fill on success.
      createConversation.mutate(undefined, {
        onSuccess: () => {
          setInput(prompt);
        },
      });
      return;
    }
    setInput(prompt);
    queueMicrotask(() => composerRef.current?.focus());
  }

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
                message.id === assistantId
                  ? { ...message, sources: normalizeSourcesPayload(payload) ?? undefined }
                  : message,
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

  const canSend = selectedId !== null && !isStreaming && input.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <PageHeader
        title="Ask"
        description="Search across your PRD vault in plain English."
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[16rem_1fr]">
        <aside className="flex min-h-0 flex-col rounded-lg border bg-card p-3 text-card-foreground">
          <ConversationList
            conversations={conversations}
            isLoading={conversationsQuery.isLoading}
            isError={conversationsQuery.isError}
            activeId={selectedId}
            isBusy={isStreaming}
            createMutation={createConversation}
            deleteMutation={deleteConversation}
            pendingDeleteId={pendingDeleteId}
            onSelect={handleSelect}
            onRequestDelete={handleRequestDelete}
            onCancelDelete={handleCancelDelete}
            onConfirmDelete={handleConfirmDelete}
          />
        </aside>

        <section className="flex min-h-0 flex-col rounded-lg border bg-card text-card-foreground">
          {selectedId === null ? (
            <EmptyAskState
              isCreating={createConversation.isPending}
              onNewChat={handleNewChat}
              onPickPrompt={handleExamplePrompt}
            />
          ) : (
            <ConversationView
              detailQuery={detailQuery}
              renderedMessages={renderedMessages}
              error={error}
              input={input}
              isStreaming={isStreaming}
              canSend={canSend}
              composerRef={composerRef}
              onInputChange={setInput}
              onSubmit={handleSubmit}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyAskState({
  isCreating,
  onNewChat,
  onPickPrompt,
}: {
  isCreating: boolean;
  onNewChat: () => void;
  onPickPrompt: (prompt: string) => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyState
        icon={Sparkles}
        title="Start by asking about any PRD"
        description="Ask in plain English and get grounded answers with sources. Try a question like “What's our onboarding flow for new PMs?”"
        action={
          <div className="flex w-full max-w-md flex-col gap-3">
            <Button
              className="w-full"
              disabled={isCreating}
              type="button"
              onClick={onNewChat}
            >
              {isCreating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              New chat
            </Button>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Try one of these
              </p>
              <div className="grid gap-2">
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <Button
                    key={prompt}
                    variant="outline"
                    className="h-auto justify-start whitespace-normal py-2 text-left text-sm font-normal"
                    type="button"
                    onClick={() => onPickPrompt(prompt)}
                  >
                    {prompt}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        }
      />
    </div>
  );
}

function ConversationView({
  detailQuery,
  renderedMessages,
  error,
  input,
  isStreaming,
  canSend,
  composerRef,
  onInputChange,
  onSubmit,
}: {
  detailQuery: ReturnType<typeof useQuery<ConversationDetail>>;
  renderedMessages: RenderMessage[];
  error: string | null;
  input: string;
  isStreaming: boolean;
  canSend: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-4 border-b pb-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Conversation
          </p>
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {detailQuery.data?.title ?? 'Conversation'}
          </h2>
        </div>
        {detailQuery.isFetching ? (
          <Loader2 className="mt-1 size-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {detailQuery.isError ? (
        <p className="text-sm text-destructive">Could not load this conversation.</p>
      ) : null}

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {renderedMessages.length === 0 && !detailQuery.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <p className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
              No messages yet. Send a question to start the conversation.
            </p>
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

      <form className="grid gap-2 border-t pt-3" onSubmit={onSubmit}>
        <Textarea
          ref={composerRef}
          aria-label="Message"
          className="min-h-24 resize-y"
          disabled={isStreaming}
          placeholder="Ask about a PRD"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) {
                event.currentTarget.form?.requestSubmit();
              }
            }
          }}
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Enter to send · Shift+Enter for newline
          </p>
          <Button disabled={!canSend} type="submit">
            {isStreaming ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: RenderMessage }) {
  const isAssistant = message.role === 'assistant';
  const isStreaming = isAssistant && !message.content;

  if (!isAssistant) {
    // User turn: compact bubble aligned to the right.
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant turn: full-width, avatar + content, no heavy border box.
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {message.rewrite ? (
          <p className="text-xs italic text-muted-foreground">
            Interpreted as: {message.rewrite}
          </p>
        ) : null}
        {isStreaming ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Thinking…
          </p>
        ) : (
          <MarkdownView className="text-sm leading-6" body={message.content} />
        )}
        {message.sources && message.sources.sources.length > 0 ? (
          <SourcesPanel payload={message.sources} />
        ) : null}
      </div>
    </div>
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
            {/* The PRD id links to the in-app detail page (most useful for a web user). */}
            <Link to={`/library/${encodeURIComponent(source.id)}`} className="font-medium text-primary hover:underline">
              {source.id}
            </Link>
            {source.title ? <span className="text-muted-foreground"> · {source.title}</span> : null}
            <div className="mt-1 flex flex-wrap gap-3 text-xs font-medium text-primary">
              <Link to={`/library/${encodeURIComponent(source.id)}`}>Open PRD</Link>
              {source.source_url ? (
                <a href={source.source_url} rel="noreferrer" target="_blank">
                  Notion ↗
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