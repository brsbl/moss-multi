import { describe, expect, it, vi } from 'vitest';
import {
  asSessionAnswer, createAuthStore, LOOKUP_TIMEOUT_MS, refusalMessage, RETRY_MS, safeNext, SIGN_OUT_PATH, UNREACHABLE, type AuthDeps,
  type AuthState,
} from './auth-state.ts';

const ADA = { id: 'u1', name: 'Ada', email: 'ada@example.invalid' };

function store(lookups: unknown[], respond: (path: string, init?: RequestInit) => Response | Promise<Response> = () => Response.json({})) {
  const answers = [...lookups];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => respond(String(input), init));
  const deps: AuthDeps = {
    lookup: vi.fn(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
    fetch,
    leave: vi.fn(),
    setAppState: vi.fn(),
    // Backoff waits end at once; a lookup's timeout ends only when woken, so a quick answer always beats it.
    sleep: vi.fn(async (ms: number, wake: Promise<void>) => (ms === LOOKUP_TIMEOUT_MS ? wake : undefined)),
  };
  const auth = createAuthStore(deps);
  const seen: AuthState['status'][] = [];
  auth.subscribe((state) => seen.push(state.status));
  return { auth, deps, fetch, seen };
}

describe('the auth store (the single auth-state writer)', () => {
  it('retries a failed lookup in place as degraded until the server answers, then boots on', async () => {
    const { auth, deps, seen } = store([new Error('network'), { kind: 'unavailable' }, 'garbage', { kind: 'signed-in', user: ADA }]);
    await expect(auth.resolve()).resolves.toEqual(ADA);
    expect(deps.lookup).toHaveBeenCalledTimes(4);
    expect(seen).toEqual(['degraded', 'degraded', 'degraded', 'signed-in']);
    expect(vi.mocked(deps.setAppState).mock.calls).toEqual([['degraded'], ['degraded'], ['degraded'], ['booting']]);
    const backoff = vi.mocked(deps.sleep!).mock.calls.map(([ms]) => ms).filter((ms) => ms !== LOOKUP_TIMEOUT_MS);
    expect(backoff).toEqual([1_000, 2_000, 4_000]);
  });

  it('asks again at once on retryNow instead of waiting out the backoff', async () => {
    const answers: unknown[] = [{ kind: 'unavailable' }, { kind: 'signed-in', user: ADA }];
    // No `sleep` dep: the real wait, 1 s before the second lookup.
    const lookup = vi.fn(async () => answers.shift());
    const auth = createAuthStore({ lookup, fetch: vi.fn<typeof globalThis.fetch>(), leave: vi.fn(), setAppState: vi.fn() });
    const degraded = new Promise<void>((done) => auth.subscribe((state) => state.status === 'degraded' && done()));
    const resolved = auth.resolve();
    await degraded;
    auth.retryNow();
    const raced = await Promise.race([resolved, new Promise((done) => setTimeout(() => done('still waiting'), 250))]);
    expect(raced).toEqual(ADA);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('counts a lookup that never answers as failed after the timeout, asks again, and takes a late answer', async () => {
    let answerLate: (value: unknown) => void = () => undefined;
    const hanging = [new Promise((done) => (answerLate = done))];
    const lookup = vi.fn(() => hanging.shift() ?? new Promise(() => undefined));
    const timers: { ms: number; fire: () => void }[] = [];
    const sleep = vi.fn((ms: number, wake: Promise<void>) => new Promise<void>((fire) => {
      timers.push({ ms, fire });
      void wake.then(() => fire());
    }));
    const setAppState = vi.fn();
    const auth = createAuthStore({ lookup, fetch: vi.fn<typeof globalThis.fetch>(), leave: vi.fn(), setAppState, sleep });
    const resolved = auth.resolve();

    await vi.waitFor(() => expect(timers.map((t) => t.ms), 'the first lookup is timed').toEqual([LOOKUP_TIMEOUT_MS]));
    expect(auth.get().status, 'nothing is decided while it is pending').toBe('unknown');
    timers[0].fire();
    await vi.waitFor(() => expect(auth.get().status, 'a lookup that never answers degrades in place').toBe('degraded'));
    expect(setAppState).toHaveBeenLastCalledWith('degraded');

    await vi.waitFor(() => expect(timers.map((t) => t.ms)).toEqual([LOOKUP_TIMEOUT_MS, RETRY_MS[0]]));
    timers[1].fire();
    await vi.waitFor(() => expect(lookup, 'then asks again with a new request').toHaveBeenCalledTimes(2));

    answerLate({ kind: 'signed-in', user: ADA });
    await expect(resolved, 'the abandoned lookup still answers for this boot').resolves.toEqual(ADA);
    expect(auth.get()).toEqual({ status: 'signed-in', user: ADA });
  });

  it('asks again at once on retryNow while a lookup is still waiting for its answer', async () => {
    const answers: Promise<unknown>[] = [Promise.resolve({ kind: 'unavailable' }), new Promise(() => undefined)];
    const lookup = vi.fn(() => answers.shift() ?? Promise.resolve({ kind: 'signed-in', user: ADA }));
    const sleep = vi.fn(async (ms: number, wake: Promise<void>) => (ms === LOOKUP_TIMEOUT_MS ? wake : undefined));
    const auth = createAuthStore({ lookup, fetch: vi.fn<typeof globalThis.fetch>(), leave: vi.fn(), setAppState: vi.fn(), sleep });
    const resolved = auth.resolve();
    await vi.waitFor(() => expect(lookup, 'the second lookup is in flight').toHaveBeenCalledTimes(2));
    expect(auth.get().status).toBe('degraded');
    auth.retryNow();
    const raced = await Promise.race([resolved, new Promise((done) => setTimeout(() => done('still waiting'), 250))]);
    expect(raced, 'Try again does not wait on the hung lookup').toEqual(ADA);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('says signed out only when the server says so', async () => {
    const { auth, seen } = store([{ kind: 'signed-out' }]);
    await expect(auth.resolve()).resolves.toBeNull();
    expect(seen).toEqual(['signed-out']);
  });

  it('signs out with JSON {}, stopping subscribers before the request returns, then leaves for /login', async () => {
    let release: () => void = () => undefined;
    const { auth, deps, fetch, seen } = store([{ kind: 'signed-in', user: ADA }], () => new Promise((done) => (release = () => done(Response.json({ success: true })))));
    await auth.resolve();
    const pending = auth.signOut();
    expect(auth.get().status, 'synchronously on the gesture').toBe('signing-out');
    expect(fetch).toHaveBeenCalledWith(SIGN_OUT_PATH, expect.objectContaining({ method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    release();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(seen).toEqual(['signed-in', 'signing-out', 'signed-out']);
    expect(deps.leave).toHaveBeenCalledWith('/login');
  });

  it('leaves for a given destination after sign-out, keeping /login as the default', async () => {
    const { auth, deps } = store([{ kind: 'signed-in', user: ADA }], () => Response.json({ success: true }));
    await auth.resolve();
    const back = `/login?next=${encodeURIComponent('/invite/abc')}`;
    await expect(auth.signOut(back)).resolves.toEqual({ ok: true });
    expect(auth.get().status).toBe('signed-out');
    expect(deps.leave).toHaveBeenCalledWith(back);
  });

  it('keeps the session when sign-out is refused', async () => {
    const { auth, deps } = store([{ kind: 'signed-in', user: ADA }], () => new Response('{}', { status: 500 }));
    await auth.resolve();
    expect(await auth.signOut()).toMatchObject({ ok: false });
    expect(auth.get()).toEqual({ status: 'signed-in', user: ADA });
    expect(deps.leave).not.toHaveBeenCalled();
  });

  it('asks the server when the sign-out response is lost, and leaves for /login when the session is gone', async () => {
    const lost = () => {
      throw new TypeError('Failed to fetch');
    };
    const gone = store([{ kind: 'signed-in', user: ADA }, { kind: 'signed-out' }], lost);
    await gone.auth.resolve();
    expect(await gone.auth.signOut(), 'better-auth ended the session; only its answer was lost').toEqual({ ok: true });
    expect(gone.auth.get().status).toBe('signed-out');
    expect(gone.deps.leave).toHaveBeenCalledWith('/login');

    const kept = store([{ kind: 'signed-in', user: ADA }, { kind: 'signed-in', user: ADA }], lost);
    await kept.auth.resolve();
    expect(await kept.auth.signOut(), 'the request never reached the server').toEqual({ ok: false, message: UNREACHABLE });
    expect(kept.auth.get()).toEqual({ status: 'signed-in', user: ADA });
    expect(kept.deps.leave).not.toHaveBeenCalled();
  });

  it('turns better-auth refusals into sentences', async () => {
    const { auth } = store([], () => Response.json({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, { status: 401 }));
    expect(await auth.signIn({ email: 'ada@example.invalid', password: 'nope' })).toEqual({ ok: false, message: 'That email and password don’t match an account.' });
    expect(refusalMessage(null, 422)).toMatch(/already exists/);
    expect(refusalMessage({ code: 'SOMETHING_NEW' }, 500)).toBe('Something went wrong. Try again.');
    // The day-long sign-up limit never tells the person to wait a moment.
    expect(refusalMessage({ code: 'TOO_MANY_SIGN_UPS' }, 429)).toMatch(/today/);
    expect(refusalMessage({ code: 'TOO_MANY_SIGN_UPS' }, 429)).not.toMatch(/moment/);
  });

  it('names the active password minimum when a password is too short', async () => {
    expect(refusalMessage({ code: 'PASSWORD_TOO_SHORT' }, 400, { minPasswordLength: 12 })).toBe('That password is too short. Use at least 12 characters.');
    expect(refusalMessage({ code: 'PASSWORD_TOO_SHORT' }, 400), 'with no known minimum it still asks for a longer one').toMatch(/too short/);
    const { auth } = store([], () => Response.json({ code: 'PASSWORD_TOO_SHORT', message: 'Password too short' }, { status: 400 }));
    expect(await auth.signUp({ email: 'ada@example.invalid', password: 'abc' }, { minPasswordLength: 12 })).toEqual({
      ok: false,
      message: 'That password is too short. Use at least 12 characters.',
    });
  });

  it('signs a new account in, deriving a name from the email when none is given', async () => {
    const { auth, fetch } = store([], () => Response.json({ token: 't', user: ADA }));
    expect(await auth.signUp({ email: 'ada@example.invalid', password: 'long-enough-pw', name: ' ' })).toEqual({ ok: true, user: ADA });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ email: 'ada@example.invalid', password: 'long-enough-pw', name: 'ada' });
    expect(auth.get().status).toBe('signed-in');
  });
});

describe('session answers and next paths', () => {
  it('accepts only well-formed answers', () => {
    expect(asSessionAnswer({ kind: 'signed-in', user: ADA })).toEqual({ kind: 'signed-in', user: ADA });
    expect(asSessionAnswer({ kind: 'signed-out' })).toEqual({ kind: 'signed-out' });
    for (const bad of [null, undefined, {}, { kind: 'signed-in', user: { id: '' } }, new Response('x'), 'signed-out']) {
      expect(asSessionAnswer(bad)).toEqual({ kind: 'unavailable' });
    }
  });

  it('returns only to same-origin paths, never to /login', () => {
    expect(safeNext('/d/abc?x=1#h')).toBe('/d/abc?x=1#h');
    expect(safeNext('/d/abc/../xyz?next=//evil.example#//x')).toBe('/d/xyz?next=//evil.example#//x');
    expect(safeNext('/%2F%2Fevil.example'), 'an encoded slash stays a path').toBe('/%2F%2Fevil.example');
    for (const bad of [undefined, '', 'https://evil.example/', '//evil.example/x', '/\\evil.example', '/login?next=/', '/login', '/x/../login']) {
      expect(safeNext(bad), String(bad)).toBe('/');
    }
  });

  it('never returns a path that normalizes to a protocol-relative //host', () => {
    const escapes = ['/x/..//evil.example', '/.//evil.example', '/%2e%2e//evil.example', '/a/../\\evil.example', '/..//evil.example/x?y#z', '/./\\evil.example', '/x/..//[evil'];
    for (const next of escapes) expect(safeNext(next), next).toBe('/');
  });
});
