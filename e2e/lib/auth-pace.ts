// Off the hook stack (staging and the canary rehearsal) sign-in and sign-up are each limited to 10 per address
// (apps/web/src/auth/auth.ts), and better-auth resets a count only after 60 s with no allowed request. A run's auth
// requests all come from this process, so it keeps a model of both counts and waits before a request would be refused:
// setup leaves RESERVE requests for the legs that sign in or up through the card. Waits extend the running test's
// timeout, since they are setup's and not the leg's. The model is kept in a file beside the stack state, because
// Playwright starts a fresh worker after a failure while the server's counts carry on.
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from '@playwright/test';

export type AuthKind = 'sign-in' | 'sign-up';

const MAX = 10;
const WINDOW_MS = 60_000;
const SLACK_MS = 1_500;
/** Requests setup leaves for a leg's own sign-in or sign-up through the card. */
export const RESERVE = 3;

let enabled = false;
let storePath: string | null = null;
const counts = new Map<string, { count: number; last: number }>();

/**
 * Paces auth requests against `origin` (a stack with no test hooks), or stops pacing (null). With `path`, the counts an
 * earlier worker of this run recorded there carry over, and each one recorded is written back.
 */
export function paceAuth(origin: string | null, path: string | null = null): void {
  enabled = origin !== null;
  storePath = enabled ? path : null;
  counts.clear();
  if (!storePath) return;
  try {
    const saved = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, { count: number; last: number }>;
    for (const kind of ['sign-in', 'sign-up']) {
      const state = saved[kind];
      if (Number.isFinite(state?.count) && Number.isFinite(state?.last)) counts.set(kind, { count: state.count, last: state.last });
    }
  } catch {
    // None recorded yet.
  }
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
  if (storePath) writeFileSync(storePath, JSON.stringify(Object.fromEntries(counts)));
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
