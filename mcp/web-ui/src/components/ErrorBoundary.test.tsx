import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ErrorBoundary } from './ErrorBoundary';

function Boom(): React.ReactElement {
  throw new Error('kaboom-from-child');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React + the boundary both log to console.error on a caught throw; silence
    // the expected noise so the test output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('renders the fallback UI and a reload button when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('kaboom-from-child')).toBeInTheDocument();

    const reloadButton = screen.getByRole('button', { name: /reload page/i });
    expect(reloadButton).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /back to library/i })).toHaveAttribute(
      'href',
      '/library',
    );
  });

  it('logs the caught error to console.error', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(console.error).toHaveBeenCalled();
  });
});
