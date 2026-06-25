import { Loader2, MessageSquarePlus, Trash2 } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RelativeTime } from '@/components/RelativeTime';
import { cn } from '@/lib/utils';
import { truncate } from '@/lib/format';

export interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
}

export interface ConversationListProps {
  conversations: ConversationSummary[];
  isLoading: boolean;
  isError: boolean;
  activeId: string | null;
  isBusy: boolean;
  createMutation: UseMutationResult<{ id: string }, Error, void, unknown>;
  deleteMutation: UseMutationResult<void, Error, string, unknown>;
  pendingDeleteId: string | null;
  onSelect: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

export function ConversationList({
  conversations,
  isLoading,
  isError,
  activeId,
  isBusy,
  createMutation,
  deleteMutation,
  pendingDeleteId,
  onSelect,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: ConversationListProps) {
  const hasNoConversations = conversations.length === 0;

  return (
    <div className="flex h-full flex-col gap-3">
      <Button
        aria-label="Start new chat"
        className="w-full justify-start"
        disabled={isBusy || createMutation.isPending}
        type="button"
        onClick={() => createMutation.mutate()}
      >
        {createMutation.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <MessageSquarePlus className="size-4" />
        )}
        New chat
      </Button>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading conversations…
          </p>
        ) : null}

        {isError ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Could not load conversations.
          </p>
        ) : null}

        {hasNoConversations && !isLoading && !isError ? (
          <div className="flex h-full min-h-[160px] items-center justify-center px-2 text-center">
            <p className="text-sm text-muted-foreground">
              Your Ask history will appear here.
            </p>
          </div>
        ) : null}

        {conversations.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {conversations.map((conversation) => {
              const isActive = conversation.id === activeId;
              return (
                <li
                  key={conversation.id}
                  className={cn(
                    'group relative flex items-stretch rounded-md transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/60',
                  )}
                >
                  <button
                    aria-label={`Open conversation ${truncate(conversation.title || 'New chat', 60)}`}
                    className="min-w-0 flex-1 rounded-md px-3 py-2 text-left"
                    disabled={isBusy && isActive}
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                  >
                    <span className="block truncate text-sm font-medium">
                      {truncate(conversation.title || 'New chat', 60)}
                    </span>
                    <span
                      className={cn(
                        'block text-xs',
                        isActive
                          ? 'text-accent-foreground/70'
                          : 'text-muted-foreground',
                      )}
                    >
                      <RelativeTime date={conversation.updated_at} refreshMs={30_000} />
                    </span>
                  </button>
                  <button
                    aria-label={`Delete conversation ${truncate(conversation.title, 60)}`}
                    className={cn(
                      'mr-1 inline-flex items-center justify-center self-center rounded-md p-1.5 transition-opacity',
                      'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                      isActive
                        ? 'text-accent-foreground/80 hover:bg-destructive/20 hover:text-destructive-foreground'
                        : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                    )}
                    disabled={deleteMutation.isPending && pendingDeleteId === conversation.id}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRequestDelete(conversation.id);
                    }}
                  >
                    {deleteMutation.isPending && pendingDeleteId === conversation.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <Dialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) onCancelDelete();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this conversation?</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleteMutation.isPending}
              type="button"
              onClick={onCancelDelete}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              type="button"
              onClick={onConfirmDelete}
            >
              {deleteMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}