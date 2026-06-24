import { type FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { ApiError, apiFetch } from '../lib/api';
import { ERROR_COPY } from '../lib/error-copy';

export function Login() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await apiFetch('/auth/login', { method: 'POST', body: { email, password } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.code === 'invalid_credentials')) {
        setError(ERROR_COPY.invalid_credentials);
      } else {
        setError(ERROR_COPY.default);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <form
        aria-label="Sign in"
        className="w-full max-w-sm space-y-5 rounded-lg border bg-card p-6 shadow-sm"
        onSubmit={onSubmit}
      >
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">Use your LLM Wiki account.</p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="login-email">
            Email
          </label>
          <input
            autoComplete="email"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            id="login-email"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="login-password">
            Password
          </label>
          <input
            autoComplete="current-password"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            id="login-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </div>

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <button
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
