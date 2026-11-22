// Settings' Account section (T0.10), the web build's one addition to moss Settings: who is signed in, and Sign
// out. Moss has no accounts, so it uses Settings' own section vocabulary (micro label over a bordered card).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { auth, useAuthState } from '../auth.ts';

// The app menu's Account (T9.30) opens Settings scrolled to this section.
let reveal = false;
export function revealAccountSection(): void {
  reveal = true;
}

export function AccountSection(): ReactNode {
  const state = useAuthState();
  const [error, setError] = useState<string | null>(null);
  const section = useRef<HTMLDivElement | null>(null);
  const shown = state.status === 'signed-in' || state.status === 'signing-out';
  useEffect(() => {
    if (!shown || !reveal || !section.current) return;
    reveal = false;
    section.current.scrollIntoView({ block: 'nearest' });
  }, [shown]);
  if (state.status !== 'signed-in' && state.status !== 'signing-out') return null;
  const signingOut = state.status === 'signing-out';

  async function signOut(): Promise<void> {
    setError(null);
    const outcome = await auth.signOut();
    if (!outcome.ok) setError(outcome.message);
  }

  return (
    <div ref={section} data-collab-chrome="" className="space-y-2">
      <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Account</span>
      <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs" title={state.user.email}>
            {state.user.name && state.user.name !== state.user.email ? (
              <><span className="text-ink-default">{state.user.name}</span> <span className="text-ink-faint">{state.user.email}</span></>
            ) : (
              <span className="text-ink-muted">{state.user.email}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-border-subtle hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
        {error !== null && (
          <p role="alert" className="mt-1.5 text-xs text-ink-default">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
