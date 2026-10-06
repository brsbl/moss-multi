// The single auth-state writer (A§7, L§4.6): every change of who is signed in in this tab goes through one
// store: a sign-out gesture pauses writes and polling; confirmed sign-out severs sockets. Pure: the page wires the session lookup, fetch, navigation and html[data-app-state] in host/auth.ts.

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

/** What the session lookup says. `unavailable` is a transient failure, never "signed out" (R10). */
export type SessionAnswer = { kind: 'signed-in'; user: SessionUser } | { kind: 'signed-out' } | { kind: 'unavailable' };

export type AuthState =
  | { status: 'unknown' }
  | { status: 'degraded'; attempts: number }
  | { status: 'signed-in'; user: SessionUser }
  | { status: 'signing-out'; user: SessionUser }
  | { status: 'signed-out' };

export type SocialProviderId = 'github' | 'google';

export type AuthOutcome = { ok: true; user: SessionUser } | { ok: false; message: string };
export type SignOutOutcome = { ok: true } | { ok: false; message: string };

export interface Credentials {
  email: string;
  password: string;
  name?: string;
}

export interface AuthDeps {
  /** One session lookup; may throw or resolve to anything, both of which count as `unavailable`. */
  lookup: () => Promise<unknown>;
  beforeSignOut?: () => Promise<boolean>;
  fetch: typeof fetch;
  /** Leaves the page for `href` (host/navigation.ts). */
  leave: (href: string) => void;
  /** Writes html[data-app-state]. */
  setAppState: (state: 'booting' | 'degraded') => void;
  /** Waits before the next lookup; resolves early when `wake` fires. */
  sleep?: (ms: number, wake: Promise<void>) => Promise<void>;
}

/** Waits between failed lookups: 1 s, 2 s, 4 s, 8 s, then every 15 s. */
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** A lookup with no answer after this long counts as failed (a stalled Worker or D1 read), and the next one starts. */
export const LOOKUP_TIMEOUT_MS = 10_000;

type Decided = Exclude<SessionAnswer, { kind: 'unavailable' }>;
const UNAVAILABLE: SessionAnswer = { kind: 'unavailable' };

export const SIGN_IN_PATH = '/api/auth/sign-in/email';
export const SIGN_UP_PATH = '/api/auth/sign-up/email';
export const SIGN_OUT_PATH = '/api/auth/sign-out';
export const LOGIN_PATH = '/login';

const isUser = (value: unknown): value is SessionUser => {
  const user = value as Partial<SessionUser> | null;
  return !!user && typeof user.id === 'string' && user.id !== '' && typeof user.name === 'string' && typeof user.email === 'string';
};

/** Anything but a well-formed answer is `unavailable`: a definitive "signed out" must be said, never inferred. */
export function asSessionAnswer(value: unknown): SessionAnswer {
  const answer = value as { kind?: unknown; user?: unknown } | null;
  if (answer?.kind === 'signed-in' && isUser(answer.user)) {
    const { id, name, email } = answer.user;
    return { kind: 'signed-in', user: { id, name, email } };
  }
  if (answer?.kind === 'signed-out') return { kind: 'signed-out' };
  return { kind: 'unavailable' };
}

/** A same-origin path to return to after sign-in, or `/`. */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  const base = 'https://moss.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return '/';
  }
  if (url.origin !== base || url.pathname === LOGIN_PATH || url.pathname.startsWith(`${LOGIN_PATH}/`)) return '/';
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can normalize to `//host` ('/x/..//evil'), which a browser and a Location header read as another
  // origin: keep only a path that resolves back to the same URL.
  try {
    return new URL(path, base).href === url.href ? path : '/';
  } catch {
    return '/'; // `//[x` is not even a URL
  }
}

const MISMATCH = 'That email and password don’t match an account.';
const EXISTS = 'An account with that email already exists. Sign in instead.';
const TOO_MANY = 'Too many attempts just now. Wait a moment and try again.';
export const UNREACHABLE = 'Couldn’t reach the server. Check your connection and try again.';
const GENERIC = 'Something went wrong. Try again.';

const BY_CODE: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: MISMATCH,
  INVALID_PASSWORD: MISMATCH,
  USER_NOT_FOUND: MISMATCH,
  USER_ALREADY_EXISTS: EXISTS,
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: EXISTS,
  PASSWORD_TOO_SHORT: 'That password is too short. Choose a longer one.',
  PASSWORD_TOO_LONG: 'That password is too long. Choose a shorter one.',
  INVALID_EMAIL: 'That doesn’t look like an email address.',
  TOO_MANY_SIGN_UPS: 'Too many sign-ups from this network today. Try again tomorrow.',
};

const BY_STATUS: Record<number, string> = { 401: MISMATCH, 422: EXISTS, 429: TOO_MANY };

/** better-auth's refusal as a sentence a person can act on; never empty, never a raw code. */
export function refusalMessage(body: unknown, status: number): string {
  const code = (body as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && BY_CODE[code]) || BY_STATUS[status] || GENERIC;
}

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const defaultSleep = (ms: number, wake: Promise<void>) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void wake.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

export function createAuthStore(deps: AuthDeps) {
  const sleep = deps.sleep ?? defaultSleep;
  let state: AuthState = { status: 'unknown' };
  const listeners = new Set<(state: AuthState) => void>();
  let resolving: Promise<SessionUser | null> | null = null;
  let wakeNow: () => void = () => undefined;
  let woken = false;

  /** Waits `ms`, or until retryNow; `woken` says which. */
  function pause(ms: number): Promise<void> {
    woken = false;
    const wake = new Promise<void>((done) => {
      wakeNow = () => {
        woken = true;
        done();
      };
    });
    return sleep(ms, wake);
  }

  /** The one writer: listeners synchronously pause writes before the sign-out guard awaits acks. */
  function write(next: AuthState): void {
    const wasDegraded = state.status === 'degraded';
    state = next;
    if (next.status === 'degraded') deps.setAppState('degraded');
    else if (wasDegraded) deps.setAppState('booting');
    for (const listener of [...listeners]) listener(state);
  }

  async function ask(): Promise<SessionAnswer> {
    try {
      return asSessionAnswer(await deps.lookup());
    } catch {
      return UNAVAILABLE;
    }
  }

  /** Asks until the server says signed in or signed out, publishing `degraded` while it cannot (R10). */
  async function untilDecided(): Promise<Decided> {
    // The first definitive answer wins, even from a lookup that answers after its own attempt timed out.
    let decide: (answer: Decided) => void = () => undefined;
    const decided = new Promise<Decided>((done) => (decide = done));
    for (let attempt = 0; ; attempt += 1) {
      const reply = ask().then((result) => {
        if (result.kind !== 'unavailable') decide(result);
        return result;
      });
      const first = await Promise.race([decided, reply, pause(LOOKUP_TIMEOUT_MS).then(() => UNAVAILABLE)]);
      if (first.kind !== 'unavailable') return first;
      if (woken) continue; // "Try again" while a lookup hangs asks again at once
      write({ status: 'degraded', attempts: attempt + 1 });
      const late = await Promise.race([decided, pause(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]).then(() => null)]);
      if (late) return late;
    }
  }

  async function resolveLoop(): Promise<SessionUser | null> {
    const answer = await untilDecided();
    if (answer.kind === 'signed-out') {
      write({ status: 'signed-out' });
      return null;
    }
    write({ status: 'signed-in', user: answer.user });
    return answer.user;
  }

  async function credentialRequest(path: string, body: Record<string, string>): Promise<AuthOutcome & { session?: boolean }> {
    let response: Response;
    try {
      response = await deps.fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, message: UNREACHABLE };
    }
    const payload = await readJson(response);
    if (!response.ok) return { ok: false, message: refusalMessage(payload, response.status) };
    const { user, token } = (payload ?? {}) as { user?: unknown; token?: unknown };
    if (!isUser(user)) return { ok: false, message: GENERIC };
    return { ok: true, user: { id: user.id, name: user.name, email: user.email }, session: token !== null };
  }

  function signedOut(): SignOutOutcome {
    write({ status: 'signed-out' });
    deps.leave(LOGIN_PATH);
    return { ok: true };
  }

  async function signIn({ email, password }: Credentials): Promise<AuthOutcome> {
    const outcome = await credentialRequest(SIGN_IN_PATH, { email, password });
    if (!outcome.ok) return outcome;
    write({ status: 'signed-in', user: outcome.user });
    return { ok: true, user: outcome.user };
  }

  return {
    get: (): AuthState => state,

    subscribe(listener: (state: AuthState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Who is signed in, for a route that needs a session. Retries a failed lookup in place, publishing
     * `degraded` between attempts, until the server says signed in or signed out.
     */
    resolve(): Promise<SessionUser | null> {
      if (state.status === 'signed-in') return Promise.resolve(state.user);
      resolving ??= resolveLoop().finally(() => {
        resolving = null;
      });
      return resolving;
    },

    /** Asks again now ("Try again", back online, tab visible again), without waiting out a backoff or a hung lookup. */
    retryNow(): void {
      wakeNow();
    },

    signIn,

    /** Open sign-up (P:People); better-auth signs the new account in. A blank name becomes the email's local part. */
    async signUp({ email, password, name }: Credentials): Promise<AuthOutcome> {
      const display = name?.trim() || email.split('@')[0] || email;
      const created = await credentialRequest(SIGN_UP_PATH, { email, password, name: display });
      if (!created.ok) return created;
      // A sign-up that set no session (auto sign-in off) still has to end signed in.
      if (!created.session) return signIn({ email, password });
      write({ status: 'signed-in', user: created.user });
      return { ok: true, user: created.user };
    },

    /** Posts JSON `{}` (better-auth 415s without it), then leaves for the login card. A refusal changes nothing. */
    async signOut(): Promise<SignOutOutcome> {
      if (state.status !== 'signed-in') return { ok: false, message: GENERIC };
      const { user } = state;
      write({ status: 'signing-out', user });
      if (deps.beforeSignOut && !await deps.beforeSignOut()) {
        write({ status: 'signed-in', user });
        return { ok: false, message: 'Sign-out cancelled. Your edits are kept here.' };
      }
      let response: Response;
      try {
        response = await deps.fetch(SIGN_OUT_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      } catch {
        // A lost response may hide a sign-out that happened: ask the server before keeping the session.
        const never = new Promise<void>(() => undefined);
        const answer = await Promise.race([ask(), sleep(LOOKUP_TIMEOUT_MS, never).then(() => UNAVAILABLE)]);
        if (answer.kind === 'signed-out') return signedOut();
        write({ status: 'signed-in', user });
        return { ok: false, message: UNREACHABLE };
      }
      if (!response.ok) {
        write({ status: 'signed-in', user });
        return { ok: false, message: 'Couldn’t sign you out. Try again.' };
      }
      return signedOut();
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
