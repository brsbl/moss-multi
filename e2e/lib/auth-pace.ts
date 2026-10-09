// Off the hook stack (staging and the canary rehearsal) sign-in and sign-up are each limited to 10 per address
// (apps/web/src/auth/auth.ts), and better-auth resets a count only after 60 s with no allowed request. A run's auth
// requests all come from this process, so it keeps a model of both counts and waits before a request would be refused:
// setup leaves RESERVE requests for the legs that sign in or up through the card. Waits extend the running test's
// timeout, since they are setup's and not the leg's.
import { test } from '@playwright/test';

export type AuthKind = 'sign-in' | 'sign-up';

const MAX = 10;
const WINDOW_MS = 60_000;
const SLACK_MS = 1_500;
/** Requests setup leaves for a leg's own sign-in or sign-up through the card. */
export const RESERVE = 3;

let enabled = false;
const counts = new Map<string, { count: number; last: number }>();

/** Paces auth requests against `origin` (a stack with no test hooks), or stops pacing (null). */
export function paceAuth(origin: string | null): void {
  enabled = origin !== null;
  counts.clear();
}

/** The auth limit a request to `url` counts against, if any. */
export function authKind(url: string, method = 'POST'): AuthKind | null {
  if (method !== 'POST') return null;
  const path = new URL(url).pathname;
  if (path.startsWith('/api/auth/sign-in/')) return 'sign-in';
  if (path.startsWith('/api/auth/sign-up/')) return 'sign-up';
  return null;
}

/** Records one auth request the server answered with anything but 429 (a refused one does not count). */
export function recordAuth(kind: AuthKind, at = Date.now()): void {
  const state = counts.get(kind);
  if (!state || at - state.last > WINDOW_MS) counts.set(kind, { count: 1, last: at });
  else counts.set(kind, { count: state.count + 1, last: at });
}

/** Grows the running test's timeout by `ms`; a no-op outside a test. */
export function extendTimeout(ms: number): void {
  try {
    const info = test.info();
    if (info.timeout > 0) info.setTimeout(info.timeout + ms);
  } catch {
    // Outside a test.
  }
}

/** Waits until one more `kind` request fits under the limit with `reserve` left over. */
export async function authHeadroom(kind: AuthKind, reserve = 0): Promise<void> {
  if (!enabled) return;
  const state = counts.get(kind);
  const now = Date.now();
  if (!state || now - state.last > WINDOW_MS || state.count + 1 <= MAX - reserve) return;
  const waitMs = state.last + WINDOW_MS + SLACK_MS - now;
  extendTimeout(waitMs);
  await new Promise((done) => setTimeout(done, waitMs));
}
