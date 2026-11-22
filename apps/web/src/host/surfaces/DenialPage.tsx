// The denial surface (A§4.2): one page for every doc the caller cannot open, whether it is missing, trashed or not
// theirs, so the page says no more than the API's identical 404 does. It is a small title, one sentence and only the
// next steps that exist (T9.37): signed out, Sign in back to the same URL; signed in, back to your notes or another
// account, which also returns here. Nothing promises a request-access service. Route chunks carry it, so it uses
// moss's tokens directly rather than moss's Button (which pulls in the whole primitives barrel).
import { useEffect, useState, type ReactNode } from 'react';
import { setAppState } from '../app-state.ts';
import { auth } from '../auth.ts';
import { LOGIN_PATH } from '../auth-state.ts';
import { leaveTo } from '../navigation.ts';

const ACTION =
  'rounded-md bg-border-subtle px-3 py-1.5 text-xs font-medium text-ink-default shadow-sm transition-colors hover:bg-border-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 disabled:opacity-60';

const here = (): string => (typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`);

function Page({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <main className="flex h-full min-h-screen w-full items-center justify-center bg-surface-panel px-6">
      <div className="flex max-w-sm flex-col items-center gap-1.5 text-center">
        <h1 className="text-sm font-medium text-ink-default">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Ends this session and comes back to this page signed out, at the login card; a refusal stays and says why. */
function useAnotherAccount(): { leaving: boolean; error: string | null; switchAccount: () => Promise<void> } {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function switchAccount(): Promise<void> {
    setLeaving(true);
    setError(null);
    const outcome = await auth.signOut(`${LOGIN_PATH}?next=${encodeURIComponent(here())}`);
    if (outcome.ok) return; // the page is leaving
    setError(outcome.message);
    setLeaving(false);
  }
  return { leaving, error, switchAccount };
}

/** Moss's inline form error: 12 px terracotta text, no box. */
function InlineError({ error }: { error: string | null }): ReactNode {
  return error === null ? null : (
    <p role="alert" className="m-0 mt-2 text-caption text-accent-terracotta">
      {error}
    </p>
  );
}

export function DenialPage({ signedIn, what = 'note' }: { signedIn: boolean; what?: 'note' | 'folder' }): ReactNode {
  useEffect(() => setAppState('ready'), []);
  const { leaving, error, switchAccount } = useAnotherAccount();
  return (
    <Page title={`This ${what} doesn’t exist or you don’t have access to it`}>
      <p className="text-xs text-ink-muted">
        {signedIn ? 'Check the link, or ask the person who shared it to share it with you.' : 'Sign in to open it if it was shared with you.'}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {signedIn ? (
          <>
            <button type="button" className={ACTION} disabled={leaving} onClick={() => leaveTo('/')}>
              Go to your notes
            </button>
            <button type="button" className={ACTION} disabled={leaving} onClick={() => void switchAccount()}>
              Use another account
            </button>
          </>
        ) : (
          <button type="button" className={ACTION} onClick={() => leaveTo(`${LOGIN_PATH}?next=${encodeURIComponent(here())}`)}>
            Sign in
          </button>
        )}
      </div>
      <InlineError error={error} />
    </Page>
  );
}

/** An invite link that admits nobody (forged, spent, withdrawn or dead): one page whatever the cause (A§8). */
export function InviteClosed(): ReactNode {
  useEffect(() => setAppState('ready'), []);
  return (
    <Page title="This invite link has already been used or is no longer open">
      <p className="text-xs text-ink-muted">Ask the person who shared it to send you a new link.</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" className={ACTION} onClick={() => leaveTo('/')}>
          Go to your notes
        </button>
      </div>
    </Page>
  );
}

/**
 * A live invite followed by a signed-in account whose email is not the invite's (PRODUCT ruling 19): it names no email,
 * and offers to sign out and come back here as the right account. It leaves only once the session has ended; a
 * refused or unreachable sign-out stays here, says so, and can be tried again.
 */
export function InviteForAnotherEmail(): ReactNode {
  useEffect(() => setAppState('ready'), []);
  const { leaving, error, switchAccount } = useAnotherAccount();
  return (
    <Page title="This invite is for another email">
      <p className="text-xs text-ink-muted">Sign in with the email it is for, or ask the person who shared it for a new link.</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" className={ACTION} disabled={leaving} onClick={() => void switchAccount()}>
          Sign in with another email
        </button>
        <button type="button" className={ACTION} disabled={leaving} onClick={() => leaveTo('/')}>
          Go to your notes
        </button>
      </div>
      <InlineError error={error} />
    </Page>
  );
}
