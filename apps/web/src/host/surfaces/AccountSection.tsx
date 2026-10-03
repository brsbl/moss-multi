// Settings' Account section (T0.10), the web build's one addition to moss Settings: who is signed in, and Sign
// out. Moss has no accounts, so it uses Settings' own section vocabulary (micro label over a bordered card).
import { useState, type ReactNode } from 'react';
import { auth, useAuthState } from '../auth.ts';

export function AccountSection(): ReactNode {
  const state = useAuthState();
  const [error, setError] = useState<string | null>(null);
  if (state.status !== 'signed-in' && state.status !== 'signing-out') return null;
  const signingOut = state.status === 'signing-out';

  async function signOut(): Promise<void> {
    setError(null);
    const outcome = await auth.signOut();
    if (!outcome.ok) setError(outcome.message);
  }

  return (
    <div className="space-y-2">
      <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Account</span>
      <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs text-ink-muted" title={state.user.email}>
            {state.user.email}
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
