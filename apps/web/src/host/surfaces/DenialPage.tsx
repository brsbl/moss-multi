// The denial surface (A§4.2): one page for every doc the caller cannot open, whether it is missing, trashed or not
// theirs, so the page says no more than the API's identical 404 does. Signed out, it offers Sign in back to the same
// URL. Route chunks carry it, so it uses moss's tokens directly rather than moss's Button (which pulls in the whole
// primitives barrel).
import { useEffect, type ReactNode } from 'react';
import { setAppState } from '../app-state.ts';
import { LOGIN_PATH } from '../auth-state.ts';
import { leaveTo } from '../navigation.ts';

const ACTION =
  'mt-4 rounded-md bg-border-subtle px-3 py-1.5 text-xs font-medium text-ink-default shadow-sm transition-colors hover:bg-border-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20';

export function DenialPage({ signedIn, what = 'note' }: { signedIn: boolean; what?: 'note' | 'folder' }): ReactNode {
  useEffect(() => setAppState('ready'), []);
  const here = typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`;
  return (
    <main className="flex h-full min-h-screen w-full items-center justify-center bg-surface-panel px-6">
      <div className="flex max-w-sm flex-col items-center gap-1.5 text-center">
        <h1 className="text-sm font-medium text-ink-default">This {what} doesn’t exist or you don’t have access to it</h1>
        <p className="text-xs text-ink-muted">
          {signedIn ? 'Check the link, or ask the person who shared it to share it with you.' : 'Sign in to open it if it was shared with you.'}
        </p>
        {signedIn ? (
          <button type="button" className={ACTION} onClick={() => leaveTo('/')}>
            Go to your notes
          </button>
        ) : (
          <button type="button" className={ACTION} onClick={() => leaveTo(`${LOGIN_PATH}?next=${encodeURIComponent(here)}`)}>
            Sign in
          </button>
        )}
      </div>
    </main>
  );
}

/** An invite link that admits nobody (forged, spent, withdrawn or dead): one page whatever the cause (A§8). */
export function InviteClosed(): ReactNode {
  useEffect(() => setAppState('ready'), []);
  return (
    <main className="flex h-full min-h-screen w-full items-center justify-center bg-surface-panel px-6">
      <div className="flex max-w-sm flex-col items-center gap-1.5 text-center">
        <h1 className="text-sm font-medium text-ink-default">This invite link has already been used or is no longer open</h1>
        <p className="text-xs text-ink-muted">Ask the person who shared it to send you a new link.</p>
        <button type="button" className={ACTION} onClick={() => leaveTo('/')}>
          Go to your notes
        </button>
      </div>
    </main>
  );
}
