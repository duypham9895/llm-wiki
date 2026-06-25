import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';
import { copyForError } from '@/lib/error-copy';

export interface ResetPasswordDialogUser {
  id: string;
  email: string;
}

export interface ResetPasswordDialogProps {
  user: ResetPasswordDialogUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ResetPasswordResponse {
  temporary_password: string;
}

/**
 * Admin-initiated password reset. Two states:
 *   1. pre-submit: confirms intent, generates a new password via the backend
 *   2. post-submit: shows the temporary password once with a copy button
 */
export function ResetPasswordDialog({ user, open, onOpenChange }: ResetPasswordDialogProps) {
  const [tempPassword, setTempPassword] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // Reset state when the dialog closes or switches user.
  React.useEffect(() => {
    if (!open) {
      setTempPassword(null);
      setCopied(false);
    }
  }, [open, user?.id]);

  const resetMutation = useMutation({
    mutationFn: () =>
      apiFetch<ResetPasswordResponse>(
        `/admin/users/${encodeURIComponent(user!.id)}/reset-password`,
        { method: 'POST' },
      ),
    onSuccess: (data) => {
      setTempPassword(data.temporary_password);
    },
    onError: (err) => {
      toast.error(copyForError(err));
      onOpenChange(false);
    },
  });

  async function copyPassword() {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  const isPending = resetMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isPending) return; // don't close mid-submit
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-muted p-1.5">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
            </div>
            <DialogTitle>Reset password</DialogTitle>
          </div>
          <DialogDescription>
            A temporary password will be generated and shown ONCE. Copy it now and send it to the user through a secure channel.
          </DialogDescription>
        </DialogHeader>

        {tempPassword === null ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Resetting the password for <span className="font-medium text-foreground">{user?.email}</span> will sign them
              out of all active sessions.
            </p>
            {resetMutation.isError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {copyForError(resetMutation.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => resetMutation.mutate()}
                disabled={isPending}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                  </>
                ) : (
                  'Generate new password'
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Share this password with <span className="font-medium text-foreground">{user?.email}</span>. We don't store a
              copy — once you close this dialog, you can't recover it.
            </p>
            <div className="flex items-stretch gap-2">
              <code
                data-testid="reset-temp-password"
                className="flex-1 select-all break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm"
              >
                {tempPassword}
              </code>
              <Button type="button" variant="outline" size="icon" onClick={copyPassword} aria-label="Copy password">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
