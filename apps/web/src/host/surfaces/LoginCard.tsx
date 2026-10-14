// The login card (T0.10). Moss has no accounts, so the layout is glyphdown's login card (one centered card: a mark,
// the wordmark, a two-line tagline, then the actions full width), built from moss's own card, label, input and
// button. Email and password are first-class; an OAuth button renders only for a provider the Worker registers,
// and none is configured (P:People). Fields stay disabled until hydration, so nothing typed is lost to a
// pre-hydration submit, and `/login` publishes data-app-state=ready when they open. While a request is out they are
// read-only rather than disabled, so the field being typed in keeps focus, and a refusal leaves the caret in the
// password field for the fix. Switching between sign-in and sign-up puts the caret in the first field of the new form.
import { Button } from '@moss/shared/components/ui/button';
import { Card } from '@moss/shared/components/ui/card';
import { Input } from '@moss/shared/components/ui/input';
import { Label } from '@moss/shared/components/ui/label';
import { useHydrated } from '@tanstack/react-router';
import { Sprout } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { setAppState } from '../app-state.ts';
import { auth } from '../auth.ts';
import { refusalMessage, UNREACHABLE, type SocialProviderId } from '../auth-state.ts';
import { leaveTo } from '../navigation.ts';

const TAGLINE = 'Multiplayer moss: your notes, written together in real time.';

const PROVIDER_LABELS: Record<SocialProviderId, string> = { github: 'Continue with GitHub', google: 'Continue with Google' };

type Mode = 'sign-in' | 'sign-up';

function Field({ label, ...input }: { label: string } & ComponentProps<typeof Input>): ReactNode {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-ink-muted">
        {label}
      </Label>
      {/* moss's own bordered composition (ToolbarTextInput): the DS input's default border is clear. */}
      <Input id={id} className="border-border-default" {...input} />
    </div>
  );
}

export interface LoginCardProps {
  /** Where a successful sign-in or sign-up goes, already checked by safeNext. */
  next: string;
  /** OAuth providers with credentials on this deployment; none for the reference. */
  providers: SocialProviderId[];
  /** better-auth's minimum password length here, named when a sign-up password is too short. */
  minPasswordLength?: number | null;
}

export function LoginCard({ next, providers, minPasswordLength = null }: LoginCardProps): ReactNode {
  const hydrated = useHydrated();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  // Set only by a mode switch, so a first render or a refusal never moves the caret.
  const switched = useRef(false);

  useEffect(() => setAppState('ready'), []);

  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    (mode === 'sign-up' ? nameRef : emailRef).current?.focus();
  }, [mode]);

  const signingUp = mode === 'sign-up';
  const action = signingUp ? 'Create account' : 'Sign in';
  const disabled = !hydrated || pending;
  // A disabled input drops focus to <body>, so keys typed to fix a refused password would go nowhere.
  const fieldProps = { disabled: !hydrated, readOnly: pending };

  function switchMode(): void {
    switched.current = true;
    setMode(signingUp ? 'sign-in' : 'sign-up');
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setError(null);
    setPending(true);
    const credentials = { email: email.trim(), password, name };
    const outcome = signingUp ? await auth.signUp(credentials, { minPasswordLength }) : await auth.signIn(credentials);
    if (outcome.ok) {
      leaveTo(next); // stays pending while the page leaves
      return;
    }
    setError(outcome.message);
    setPending(false);
    passwordRef.current?.focus();
  }

  async function continueWith(provider: SocialProviderId): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const response = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, callbackURL: next }),
      });
      const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
      if (response.ok && typeof body?.url === 'string') {
        leaveTo(body.url);
        return;
      }
      setError(refusalMessage(body, response.status));
    } catch {
      setError(UNREACHABLE);
    }
    setPending(false);
  }

  return (
    <main data-login-screen="" className="flex min-h-full w-full items-center justify-center bg-surface-canvas-bg px-4 py-12">
      <Card data-login-card="" className="w-full max-w-md px-8 py-12">
        <div className="flex flex-col items-center text-center">
          <span aria-hidden="true" className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-brand text-ink-on-accent">
            <Sprout className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <h1 className="m-0 mb-2 text-h1 font-semibold tracking-title text-ink-default">moss</h1>
          <p className="m-0 text-balance text-sm text-ink-muted">{TAGLINE}</p>
        </div>

        <form aria-label={action} method="post" noValidate onSubmit={submit} className="mt-8 flex flex-col gap-3">
          {signingUp && (
            <Field label="Name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} ref={nameRef} {...fieldProps} />
          )}
          <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} ref={emailRef} {...fieldProps} />
          <Field
            label="Password"
            type="password"
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            ref={passwordRef}
            {...fieldProps}
          />
          {error !== null && (
            <p role="alert" className="m-0 rounded-md border border-accent-terracotta/40 bg-surface-danger-soft px-3 py-2 text-xs text-ink-default">
              {error}
            </p>
          )}
          <Button type="submit" className="mt-2 w-full" disabled={disabled}>
            {pending ? (signingUp ? 'Creating account…' : 'Signing in…') : action}
          </Button>
        </form>

        {providers.length > 0 && (
          <div className="mt-3 flex flex-col gap-3">
            {providers.map((provider) => (
              <Button key={provider} type="button" variant="secondary" className="w-full" disabled={disabled} onClick={() => void continueWith(provider)}>
                {PROVIDER_LABELS[provider]}
              </Button>
            ))}
          </div>
        )}

        <p className="m-0 mt-6 text-center text-xs text-ink-muted">
          {signingUp ? 'Already have an account?' : 'New here?'}{' '}
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" disabled={!hydrated} onClick={switchMode}>
            {signingUp ? 'Sign in' : 'Create an account'}
          </Button>
        </p>
      </Card>
    </main>
  );
}
