// What a shell route shows while its session lookup runs: the boot frame, or, while the lookup keeps failing, the
// degraded notice (html[data-app-state=degraded], R10). It retries in place and never sends anyone to /login.
import { Button } from '@moss/shared/components/ui/button';
import type { ReactNode } from 'react';
import { auth, useAuthState } from '../auth.ts';
import { BootFrame } from '../MossAppHost.tsx';

function DegradedFrame(): ReactNode {
  return (
    <main className="flex h-full w-full items-center justify-center bg-surface-panel px-6">
      <div role="status" aria-live="polite" className="flex max-w-sm flex-col items-center gap-1.5 text-center">
        <p className="text-sm font-medium text-ink-default">Can’t reach moss right now</p>
        <p className="text-xs text-ink-muted">Retrying automatically.</p>
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => auth.retryNow()}>
          Try again
        </Button>
      </div>
    </main>
  );
}

/** The `pendingComponent` of every route that renders the moss shell. */
export function SessionPending(): ReactNode {
  const state = useAuthState();
  return <div id="root">{state.status === 'degraded' ? <DegradedFrame /> : <BootFrame />}</div>;
}
