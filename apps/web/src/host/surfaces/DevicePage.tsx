// The device page (T3.6; A§7, A§17): `moss-multi login` prints a code and this URL. Opening it with the code claims the
// code for the signed-in person (RFC 8628: the GET claims), shows the code to compare with the terminal's, and offers
// Approve and Deny; only the claimant can decide, once. The layout is glyphdown's device page, built like the login
// card from moss's card, input and button.
import { Button } from '@moss/shared/components/ui/button';
import { Card } from '@moss/shared/components/ui/card';
import { Input } from '@moss/shared/components/ui/input';
import { MonitorSmartphone } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { setAppState } from '../app-state.ts';
import { UNREACHABLE } from '../auth-state.ts';

type Phase = 'enter' | 'checking' | 'confirm' | 'approved' | 'denied';

/** better-auth stores codes uppercase without the dash; accept what people paste. */
export const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[\s-]/g, '');

async function ask(path: string, init: RequestInit = {}): Promise<{ ok: boolean; body: { status?: string; error?: string; error_description?: string } | null }> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: response.ok, body: (await response.json().catch(() => null)) as { status?: string; error?: string; error_description?: string } | null };
}

function refusal(body: { error?: string } | null): string {
  if (body?.error === 'expired_token') return 'That code has expired. Run moss-multi login again for a new one.';
  if (body?.error === 'access_denied' || body?.error === 'invalid_request') return 'That code isn’t valid. Check the code in your terminal.';
  return 'That code was already used or isn’t valid. Run moss-multi login again for a new one.';
}

export function DevicePage({ initialCode }: { initialCode: string }): ReactNode {
  const [code, setCode] = useState(initialCode);
  const [phase, setPhase] = useState<Phase>(initialCode ? 'checking' : 'enter');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => setAppState('ready'), []);

  async function claim(raw: string): Promise<void> {
    const userCode = normalizeCode(raw);
    if (!userCode) {
      setError('Enter the code shown in your terminal.');
      return;
    }
    setPending(true);
    setError(null);
    setPhase('checking');
    try {
      const answer = await ask(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
      if (!answer.ok) {
        setError(refusal(answer.body));
        setPhase('enter');
      } else if (answer.body?.status === 'approved') setPhase('approved');
      else if (answer.body?.status === 'denied') setPhase('denied');
      else setPhase('confirm');
    } catch {
      setError(UNREACHABLE);
      setPhase('enter');
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    if (started.current || !initialCode) return;
    started.current = true;
    void claim(initialCode);
  }, [initialCode]);

  async function decide(approve: boolean): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const answer = await ask(`/api/auth/device/${approve ? 'approve' : 'deny'}`, {
        method: 'POST',
        body: JSON.stringify({ userCode: normalizeCode(code) }),
      });
      if (answer.ok) setPhase(approve ? 'approved' : 'denied');
      else setError(answer.body?.error_description ? refusal(answer.body) : 'That didn’t work. Try again.');
    } catch {
      setError(UNREACHABLE);
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!pending) void claim(code);
  }

  return (
    <main className="flex min-h-full w-full items-center justify-center bg-surface-canvas-bg px-4 py-12">
      <Card className="w-full max-w-md px-8 py-12">
        <div className="flex flex-col items-center text-center">
          <span aria-hidden="true" className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-brand text-ink-on-accent">
            <MonitorSmartphone className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <h1 className="m-0 mb-2 text-h1 font-semibold tracking-title text-ink-default">Sign in a device</h1>

          {phase === 'enter' || phase === 'checking' ? (
            <>
              <p className="m-0 text-balance text-sm text-ink-muted">
                Enter the code that <code className="font-mono text-xs">moss-multi login</code> shows to connect that terminal to your account.
              </p>
              <form aria-label="Device code" noValidate onSubmit={submit} className="mt-8 flex w-full flex-col gap-3">
                <Input
                  aria-label="Code"
                  placeholder="XXXXXXXX"
                  autoComplete="off"
                  autoFocus
                  value={code}
                  readOnly={pending}
                  onChange={(event) => setCode(event.target.value)}
                  className="border-border-default text-center font-mono uppercase tracking-[0.3em]"
                />
                <Button type="submit" className="w-full" disabled={pending}>
                  {pending ? 'Checking…' : 'Continue'}
                </Button>
              </form>
            </>
          ) : null}

          {phase === 'confirm' ? (
            <>
              <p className="m-0 text-sm text-ink-muted">A device is asking to sign in as you.</p>
              <p className="m-0 mt-4 rounded-md border border-border-default px-4 py-2 font-mono text-lg font-semibold tracking-[0.3em] text-ink-default">
                {normalizeCode(code)}
              </p>
              <p className="m-0 mt-4 text-balance text-xs text-ink-muted">
                Approve only if this matches the code in your terminal. The device gets full access to your account.
              </p>
              <div className="mt-8 flex w-full gap-3">
                <Button type="button" variant="secondary" className="flex-1" disabled={pending} onClick={() => void decide(false)}>
                  Deny
                </Button>
                <Button type="button" className="flex-1" disabled={pending} onClick={() => void decide(true)}>
                  Approve
                </Button>
              </div>
            </>
          ) : null}

          {phase === 'approved' ? (
            <p role="status" className="m-0 text-balance text-sm text-ink-muted">
              <span className="block font-medium text-ink-default">Device approved</span>
              That terminal is signed in. Return to it; you can close this tab.
            </p>
          ) : null}

          {phase === 'denied' ? (
            <p role="status" className="m-0 text-balance text-sm text-ink-muted">
              <span className="block font-medium text-ink-default">Request denied</span>
              The device was not signed in. If this wasn’t you, nothing else is needed.
            </p>
          ) : null}

          {error !== null ? (
            <p role="alert" className="m-0 mt-4 w-full rounded-md border border-accent-terracotta/40 bg-surface-danger-soft px-3 py-2 text-xs text-ink-default">
              {error}
            </p>
          ) : null}
        </div>
      </Card>
    </main>
  );
}
