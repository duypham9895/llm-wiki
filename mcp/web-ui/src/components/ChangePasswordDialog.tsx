import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/api';

const schema = z
  .object({
    current: z.string().min(1, 'Current password is required'),
    next: z.string().min(8, 'New password must be at least 8 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.next !== v.current, {
    path: ['next'],
    message: 'New password must differ from current',
  })
  .refine((v) => v.next === v.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  });

type FormValues = z.infer<typeof schema>;

export interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { current: '', next: '', confirm: '' },
  });

  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        body: { current_password: values.current, new_password: values.next },
      });
      toast.success('Password updated');
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError('current', { message: 'Current password is incorrect' });
          return;
        }
        if (err.status === 400 && err.code === 'weak_password') {
          setError('next', { message: err.message || 'Password is too weak' });
          return;
        }
        if (err.status === 400 && err.code === 'same_password') {
          setError('next', { message: 'New password must differ from current' });
          return;
        }
      }
      toast.error('Could not update password');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-muted p-1.5">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
            </div>
            <DialogTitle>Change password</DialogTitle>
          </div>
          <DialogDescription>
            Use at least 8 characters. Your new password must differ from your current one.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="cp-current">Current password</Label>
            <Input id="cp-current" type="password" autoComplete="current-password" {...register('current')} />
            {errors.current && <p className="text-xs text-destructive">{errors.current.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-next">New password</Label>
            <Input id="cp-next" type="password" autoComplete="new-password" {...register('next')} />
            {errors.next && <p className="text-xs text-destructive">{errors.next.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-confirm">Confirm new password</Label>
            <Input id="cp-confirm" type="password" autoComplete="new-password" {...register('confirm')} />
            {errors.confirm && <p className="text-xs text-destructive">{errors.confirm.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Update password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
