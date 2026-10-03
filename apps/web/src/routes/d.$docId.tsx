import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ACCESS_RETRY_MS, askDocAccess } from '../host/access.ts';
import { setAppState } from '../host/app-state.ts';
import { LOGIN_PATH } from '../host/auth-state.ts';
import { requireSession } from '../host/auth.ts';
import { BootFrame, MossAppHost } from '../host/MossAppHost.tsx';
import { leaveTo } from '../host/navigation.ts';
import { DenialPage } from '../host/surfaces/DenialPage.tsx';
import { DegradedFrame, SessionPending } from '../host/surfaces/SessionFrame.tsx';

// The moss shell with the doc open: the bridge hands $docId to App as its window-context startup note (A§4.2).
// Signed out, it goes to /login?next= and back here after sign-in. A doc the caller cannot open, or one that does
// not exist, gets the denial page and moss never mounts, so it can neither open another note in its place nor try
// the doc's socket.
export const Route = createFileRoute('/d/$docId')({
  ssr: false,
  beforeLoad: requireSession,
  pendingComponent: SessionPending,
  pendingMinMs: 0,
  component: DocRoute,
});

type Gate = 'asking' | 'degraded' | 'open' | 'denied';

/** Asks once per document load whether the caller may open the doc; a transient failure retries in place (R10). */
function useDocGate(docId: string): { gate: Gate; retry: () => void } {
  const [gate, setGate] = useState<Gate>('asking');
  const wake = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stopped = false;
    void (async () => {
      for (let attempt = 0; !stopped; attempt += 1) {
        const answer = await askDocAccess(docId);
        if (stopped) return;
        if (answer.kind === 'signed-out') {
          leaveTo(`${LOGIN_PATH}?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
          return;
        }
        if (answer.kind !== 'unavailable') {
          if (attempt > 0) setAppState('booting');
          setGate(answer.kind === 'open' ? 'open' : 'denied');
          return;
        }
        setGate('degraded');
        setAppState('degraded');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ACCESS_RETRY_MS[Math.min(attempt, ACCESS_RETRY_MS.length - 1)]);
          wake.current = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    })();
    return () => {
      stopped = true;
      wake.current();
    };
  }, [docId]);
  return { gate, retry: () => wake.current() };
}

function DocRoute(): ReactNode {
  const { docId } = Route.useParams();
  const { gate, retry } = useDocGate(docId);
  if (gate === 'open') return <MossAppHost />;
  if (gate === 'denied') return <DenialPage signedIn />;
  return <div id="root">{gate === 'degraded' ? <DegradedFrame onRetry={retry} /> : <BootFrame />}</div>;
}
