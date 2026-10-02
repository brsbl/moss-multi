import { describe, expect, it, vi } from 'vitest';
import { asSessionAnswer, createAuthStore, refusalMessage, safeNext, SIGN_OUT_PATH, type AuthDeps, type AuthState } from './auth-state.ts';

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
    sleep: vi.fn(async () => undefined),
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
    expect(vi.mocked(deps.sleep!).mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000]);
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

  it('keeps the session when sign-out is refused', async () => {
    const { auth, deps } = store([{ kind: 'signed-in', user: ADA }], () => new Response('{}', { status: 500 }));
    await auth.resolve();
    expect(await auth.signOut()).toMatchObject({ ok: false });
    expect(auth.get()).toEqual({ status: 'signed-in', user: ADA });
    expect(deps.leave).not.toHaveBeenCalled();
  });

  it('turns better-auth refusals into sentences', async () => {
    const { auth } = store([], () => Response.json({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, { status: 401 }));
    expect(await auth.signIn({ email: 'ada@example.invalid', password: 'nope' })).toEqual({ ok: false, message: 'That email and password don’t match an account.' });
    expect(refusalMessage(null, 422)).toMatch(/already exists/);
    expect(refusalMessage({ code: 'SOMETHING_NEW' }, 500)).toBe('Something went wrong. Try again.');
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
    for (const bad of [undefined, '', 'https://evil.example/', '//evil.example/x', '/\\evil.example', '/login?next=/', '/login']) {
      expect(safeNext(bad), String(bad)).toBe('/');
    }
  });
});
