import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error', error, info);
  }

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            An unexpected error occurred. You can reload the page or head back to the library.
          </p>
        </div>

        <details className="mx-auto max-w-md text-left">
          <summary className="cursor-pointer text-sm text-muted-foreground">Error details</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-card/50 p-3 text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {error.message || String(error)}
          </pre>
        </details>

        <div className="mt-2 flex items-center gap-3">
          <Button variant="default" size="sm" onClick={() => window.location.reload()}>
            Reload page
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href="/library">Back to Library</a>
          </Button>
        </div>
      </div>
    );
  }
}
