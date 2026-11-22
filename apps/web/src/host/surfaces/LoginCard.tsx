// The login card (T0.10), as a quiet task (T9.37). Moss has no accounts, so this is a modest form column on the
// canvas, as Obsidian and Linear sign in, built from Moss's own task-form recipe (its Rename Folder dialog: muted
// labels, raised-control fields, a 36 px action, an inline 12 px error with no box) under Moss's 18 px card heading.
// Email and password are first-class; an OAuth button renders only for a provider the Worker registers, and none is
// configured (P:People). Fields stay disabled until hydration, so nothing typed is lost to a pre-hydration submit, and
// `/login` publishes data-app-state=ready when they open. While a request is out they are read-only rather than
// disabled, so the field being typed in keeps focus, and a refusal leaves the caret in the password field for the fix.
// The error's line is reserved, so a message never moves the form. Switching between sign-in and sign-up puts the
// caret in the first field of the new form. An invite's column says so without naming its email and still opens on
// Sign in; a share link's offers the way back.
import { Button } from '@moss/shared/components/ui/button';
import { useHydrated } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { setAppState } from '../app-state.ts';
import { auth } from '../auth.ts';
import { backToLabel, INVITED_TAGLINE, looksLikeEmail, NOT_AN_EMAIL, refusalMessage, UNREACHABLE, type SocialProviderId } from '../auth-state.ts';
import { leaveTo } from '../navigation.ts';

const PROVIDER_LABELS: Record<SocialProviderId, string> = { github: 'Continue with GitHub', google: 'Continue with Google' };

type Mode = 'sign-in' | 'sign-up';

/** Moss's Rename Folder field, terracotta-edged while it is what the error names. */
const FIELD =
  'mt-1.5 w-full rounded-lg border bg-surface-raised-control px-3 py-2 text-sm text-ink-default placeholder:text-ink-faint/50 focus:outline-none focus:ring-2 focus:ring-ink-default/20 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60';

/** Moss's Rename Folder primary action, full width: 36 px. */
const SUBMIT =
  'h-9 w-full rounded-lg bg-accent-brand px-4 text-sm font-medium text-ink-on-accent transition hover:bg-accent-brand-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

const LINK = 'h-auto p-0 text-xs';

function Field({ label, invalid, ...input }: { label: string; invalid: boolean } & ComponentProps<'input'>): ReactNode {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-ink-muted">
        {label}
      </label>
      <input id={id} aria-invalid={invalid || undefined} className={`${FIELD} ${invalid ? 'border-accent-terracotta' : 'border-border-subtle'}`} {...input} />
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
  // The field the error is about, if it is about one.
  const [invalid, setInvalid] = useState<'email' | 'password' | null>(null);
  const [pending, setPending] = useState(false);
  const errorId = useId();
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
  const invited = next.startsWith('/invite/');
  const backTo = backToLabel(next);
  const action = signingUp ? 'Create account' : 'Sign in';
  const disabled = !hydrated || pending;
  // A disabled input drops focus to <body>, so keys typed to fix a refused password would go nowhere.
  const fieldProps = { disabled: !hydrated, readOnly: pending };

  function fail(message: string | null, field: 'email' | 'password' | null = null): void {
    setError(message);
    setInvalid(message === null ? null : field);
  }

  function switchMode(): void {
    switched.current = true;
    setMode(signingUp ? 'sign-in' : 'sign-up');
    fail(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (!email.trim() || !password) {
      fail('Enter your email and password.', email.trim() ? 'password' : 'email');
      return;
    }
    if (!looksLikeEmail(email.trim())) {
      fail(NOT_AN_EMAIL, 'email');
      emailRef.current?.focus();
      return;
    }
    fail(null);
    setPending(true);
    const credentials = { email: email.trim(), password, name };
    const outcome = signingUp ? await auth.signUp(credentials, { minPasswordLength }) : await auth.signIn(credentials);
    if (outcome.ok) {
      leaveTo(next); // stays pending while the page leaves
      return;
    }
    fail(outcome.message);
    setPending(false);
    passwordRef.current?.focus();
  }

  async function continueWith(provider: SocialProviderId): Promise<void> {
    fail(null);
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
      fail(refusalMessage(body, response.status));
    } catch {
      fail(UNREACHABLE);
    }
    setPending(false);
  }

  const describedBy = error !== null ? errorId : undefined;
  return (
    <main data-login-screen="" className="flex min-h-full w-full items-center justify-center bg-surface-canvas-bg px-4 py-12">
      <div data-login-card="" className="w-full max-w-[400px]">
        <h1 className="m-0 text-h3 text-ink-default">{action}</h1>
        {invited && <p className="m-0 mt-1.5 text-sm text-ink-muted">{INVITED_TAGLINE}</p>}

        <form aria-label={action} method="post" noValidate onSubmit={submit} className="mt-6 flex flex-col gap-4">
          {signingUp && (
            <Field label="Name" invalid={false} type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} ref={nameRef} {...fieldProps} />
          )}
          <Field
            label="Email"
            invalid={invalid === 'email'}
            aria-describedby={invalid === 'email' ? describedBy : undefined}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            ref={emailRef}
            {...fieldProps}
          />
          <div>
            <Field
              label="Password"
              invalid={invalid === 'password'}
              aria-describedby={invalid === 'email' ? undefined : describedBy}
              type="password"
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              ref={passwordRef}
              {...fieldProps}
            />
            <div className="mt-1.5 min-h-[17px]">
              {error !== null && (
                <p id={errorId} role="alert" className="m-0 text-caption text-accent-terracotta">
                  {error}
                </p>
              )}
            </div>
          </div>
          <button type="submit" disabled={disabled} className={SUBMIT}>
            {pending ? (signingUp ? 'Creating account…' : 'Signing in…') : action}
          </button>
        </form>

        {providers.length > 0 && (
          <div className="mt-3 flex flex-col gap-3">
            {providers.map((provider) => (
              <Button key={provider} type="button" variant="secondary" size="sm" className="w-full rounded-lg" disabled={disabled} onClick={() => void continueWith(provider)}>
                {PROVIDER_LABELS[provider]}
              </Button>
            ))}
          </div>
        )}

        <p className="m-0 mt-6 text-xs text-ink-muted">
          {signingUp ? 'Already have an account?' : 'New here?'}{' '}
          <Button type="button" variant="link" size="sm" className={LINK} disabled={!hydrated} onClick={switchMode}>
            {signingUp ? 'Sign in' : 'Create an account'}
          </Button>
        </p>
        {backTo !== null && (
          <p className="m-0 mt-3 text-xs">
            <Button type="button" variant="link" size="sm" className={LINK} disabled={!hydrated} onClick={() => leaveTo(next)}>
              {backTo}
            </Button>
          </p>
        )}
      </div>
    </main>
  );
}
