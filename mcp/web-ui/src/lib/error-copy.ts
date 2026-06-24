import { ApiError } from './api';

export const ERROR_COPY: Record<string, string> = {
  conversation_busy: 'A response is already being generated in this conversation.',
  default: 'Something went wrong. Please try again.',
};

export function copyForError(err: unknown): string {
  const code = errorCode(err);
  return code ? (ERROR_COPY[code] ?? ERROR_COPY.default) : ERROR_COPY.default;
}

function errorCode(err: unknown): string | null {
  if (typeof err === 'string') return err;
  if (err instanceof ApiError) return err.code;
  if (!err || typeof err !== 'object') return null;

  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
