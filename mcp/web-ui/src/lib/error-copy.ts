import { ApiError } from './api';

export const ERROR_COPY: Record<string, string> = {
  admin_pair: 'A role must grant the admin capability fully or not at all (it pairs user and role management).',
  conversation_busy: 'A response is already being generated in this conversation.',
  default: 'Something went wrong. Please try again.',
  invalid_credentials: 'Email or password is incorrect.',
  last_admin: 'This would leave the system with no active admin. Add another admin first.',
  role_exists: 'A role with that name already exists. Choose a different name.',
  role_in_use: 'This role is still assigned to users. Reassign them before deleting it.',
  system_role_immutable: "Built-in roles (admin, member) can't be edited or deleted.",
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
