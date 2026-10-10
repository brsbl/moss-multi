// @vitest-environment jsdom
// The other-email invite page's "Sign in with another email" (B015): it signs out through the auth store and leaves
// for the login card only once the session has ended; a refused or unreachable sign-out stays here, says so, and can
// be tried again.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADA = { id: 'u1', name: 'Ada', email: 'ada@example.invalid' };
const INVITE = '/invite/abc123';

const h = vi.hoisted(() => ({
  respond: null as null | (() => Response | Promise<Response>),
  lookups: [] as unknown[],
  leave: vi.fn<(href: string) => void>(),
}));

vi.mock('../auth.ts', async () => {
  const { createAuthStore } = await import('../auth-state.ts');
  return {
    auth: createAuthStore({
      lookup: async () => h.lookups.shift(),
      fetch: vi.fn<typeof fetch>(async () => {
        if (!h.respond) throw new Error('no response set');
        return h.respond();
      }),
      leave: (href) => h.leave(href),
      setAppState: () => undefined,
      sleep: async () => undefined,
    }),
  };
});
vi.mock('../navigation.ts', () => ({ leaveTo: (href: string) => h.leave(href) }));

const { auth } = await import('../auth.ts');
const { InviteForAnotherEmail } = await import('./DenialPage.tsx');

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', INVITE);
  h.leave.mockReset();
  h.lookups = [{ kind: 'signed-in', user: ADA }];
  await auth.resolve();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(InviteForAnotherEmail)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const switchButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Sign in with another email')!;
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

async function click(): Promise<void> {
  await act(async () => {
    switchButton().click();
  });
  await act(async () => new Promise((done) => setTimeout(done, 0)));
}

describe('Sign in with another email', () => {
  it('stays on the page with a retryable error when sign-out is refused (503 SESSION_NOT_ENDED)', async () => {
    h.respond = () => Response.json({ code: 'SESSION_NOT_ENDED', message: 'Couldn’t sign you out. Try again.' }, { status: 503 });
    await click();
    expect(h.leave, 'the session survived, so the page stays').not.toHaveBeenCalled();
    expect(alertText(), 'and says why').toMatch(/sign you out/i);
    expect(switchButton().disabled, 'and the button can be pressed again').toBe(false);
    expect(auth.get()).toEqual({ status: 'signed-in', user: ADA });
  });

  it('stays on the page with a retryable error when sign-out cannot reach the server', async () => {
    h.respond = () => {
      throw new TypeError('Failed to fetch');
    };
    h.lookups.push({ kind: 'signed-in', user: ADA }); // the store asks: the session is still there
    await click();
    expect(h.leave).not.toHaveBeenCalled();
    expect(alertText()).toMatch(/reach the server/i);
    expect(switchButton().disabled).toBe(false);
  });

  it('after a failure, a retry that succeeds clears auth state and leaves for the login card back to this invite', async () => {
    h.respond = () => new Response('{}', { status: 503 });
    await click();
    expect(h.leave).not.toHaveBeenCalled();
    h.respond = () => Response.json({ success: true });
    await click();
    expect(auth.get().status).toBe('signed-out');
    expect(h.leave.mock.calls).toEqual([[`/login?next=${encodeURIComponent(INVITE)}`]]);
  });
});
