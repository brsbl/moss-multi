import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { requireSession } from '../host/auth.ts';
import { setAppState } from '../host/app-state.ts';
import { BootFrame } from '../host/MossAppHost.tsx';
import { leaveTo } from '../host/navigation.ts';
import { InviteClosed } from '../host/surfaces/DenialPage.tsx';
import { DegradedFrame, SessionPending } from '../host/surfaces/SessionFrame.tsx';

// /invite/$token (A§4.2; T2.8): redeems a copy-link invite, then goes to what it shares. Signed out it goes to the
// login card, where a guest signs in or creates an account and comes straight back here; the invite binds to whoever
// redeems it (PRODUCT ruling 19). A forged, spent, withdrawn or dead link gets the one closed-invite page.
export const Route = createFileRoute('/invite/$token')({
  ssr: false,
  beforeLoad: requireSession,
  pendingComponent: SessionPending,
  pendingMinMs: 0,
  component: InviteRoute,
});

type Answer = { kind: 'go'; href: string } | { kind: 'denied' } | { kind: 'unavailable' };

async function accept(token: string): Promise<Answer> {
  try {
    const response = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return { kind: 'denied' };
    if (!response.ok) return { kind: 'unavailable' };
    const { target } = (await response.json()) as { target: { type: 'doc' | 'folder'; id: string } };
    return { kind: 'go', href: `/${target.type === 'doc' ? 'd' : 'f'}/${encodeURIComponent(target.id)}` };
  } catch {
    return { kind: 'unavailable' };
  }
}

function InviteRoute(): ReactNode {
  const { token } = Route.useParams();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    void accept(token).then((next) => {
      if (stopped) return;
      if (next.kind === 'go') leaveTo(next.href);
      else {
        if (next.kind === 'unavailable') setAppState('degraded');
        setAnswer(next);
      }
    });
    return () => {
      stopped = true;
    };
  }, [token, attempt]);
  if (answer?.kind === 'denied') return <InviteClosed />;
  return <div id="root">{answer?.kind === 'unavailable' ? <DegradedFrame onRetry={() => { setAnswer(null); setAttempt((n) => n + 1); }} /> : <BootFrame />}</div>;
}
