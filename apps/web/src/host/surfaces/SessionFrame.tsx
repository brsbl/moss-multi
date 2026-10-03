// What a shell route shows while its session lookup runs: the boot frame, or, while the lookup keeps failing, the
// degraded notice (html[data-app-state=degraded], R10). It retries in place and never sends anyone to /login.
// Every shell route's entry chunk carries it, so it uses moss's tokens directly: moss's Button would pull in the
// whole primitives barrel.
import type { ReactNode } from 'react';
import { auth, useAuthState } from '../auth.ts';
import { BootFrame } from '../MossAppHost.tsx';

function DegradedFrame(): ReactNode {
  return (
    <main className="flex h-full w-full items-center justify-center bg-surface-panel px-6">
      <div role="status" aria-live="polite" className="flex max-w-sm flex-col items-center gap-1.5 text-center">
        <p className="text-sm font-medium text-ink-default">Can’t reach moss right now</p>
        <p className="text-xs text-ink-muted">Retrying automatically.</p>
        <button
          type="button"
          onClick={() => auth.retryNow()}
          className="mt-3 rounded-md bg-border-subtle px-3 py-1.5 text-xs font-medium text-ink-default shadow-sm transition-colors hover:bg-border-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20"
        >
          Try again
        </button>
      </div>
    </main>
  );
}

/** The `pendingComponent` of every route that renders the moss shell. */
export function SessionPending(): ReactNode {
  const state = useAuthState();
  return <div id="root">{state.status === 'degraded' ? <DegradedFrame /> : <BootFrame />}</div>;
}
