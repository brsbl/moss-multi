// The pilot's sign-up allowlist (T8.P1): with MOSS_SIGN_UP=allowlist only the emails in MOSS_ALLOWED_EMAILS may create
// an account, and an empty or missing list admits no one. Unset, sign-up is open.
import type { AppEnv } from '../env.ts';

export type AllowlistEnv = Pick<AppEnv, 'MOSS_SIGN_UP' | 'MOSS_ALLOWED_EMAILS'>;

export const SIGN_UP_NOT_ALLOWED = { code: 'SIGN_UP_NOT_ALLOWED', message: 'Sign-up here is limited to invited email addresses.' } as const;

/** The allowed emails, lowercased, or null when sign-up is open. */
export function allowedEmails(env: AllowlistEnv): Set<string> | null {
  if (env.MOSS_SIGN_UP !== 'allowlist') return null;
  return new Set((env.MOSS_ALLOWED_EMAILS ?? '').split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export function signUpAllowed(env: AllowlistEnv, email: unknown): boolean {
  const allowed = allowedEmails(env);
  if (!allowed) return true;
  return typeof email === 'string' && allowed.has(email.trim().toLowerCase());
}
