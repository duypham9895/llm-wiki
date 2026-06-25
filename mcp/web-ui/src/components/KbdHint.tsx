import * as React from 'react';
import { cn } from '@/lib/utils';

export interface KbdHintProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
}

/**
 * Compact keyboard hint chip — used in command palette rows + shortcut hints.
 * Renders as a styled <kbd>.
 */
export function KbdHint({ children, className, ...props }: KbdHintProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground shadow-sm',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
