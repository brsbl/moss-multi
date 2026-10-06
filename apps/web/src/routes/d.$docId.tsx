import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { askDocAccess } from '../host/access.ts';
import { useAccessGate } from '../host/access-gate.ts';
import { auth, requireSessionOrLink } from '../host/auth.ts';
import { BootFrame, MossAppHost } from '../host/MossAppHost.tsx';
import { DenialPage } from '../host/surfaces/DenialPage.tsx';
import { DegradedFrame, SessionPending } from '../host/surfaces/SessionFrame.tsx';

// The moss shell with the doc open: the bridge hands $docId to App as its window-context startup note (A§4.2).
// Signed out, it goes to /login?next= and back here after sign-in, unless a share link (`?share=`) opens it. A doc the
// caller cannot open, or one that does not exist, gets the denial page and moss never mounts, so it can neither open
// another note in its place nor try the doc's socket.
export const Route = createFileRoute('/d/$docId')({
  ssr: false,
  beforeLoad: requireSessionOrLink,
  pendingComponent: SessionPending,
  pendingMinMs: 0,
  component: DocRoute,
});

function DocRoute(): ReactNode {
  const { docId } = Route.useParams();
  const { gate, retry } = useAccessGate(docId, askDocAccess);
  if (gate === 'open') return <MossAppHost />;
  if (gate === 'denied') return <DenialPage signedIn={auth.get().status === 'signed-in'} />;
  return <div id="root">{gate === 'degraded' ? <DegradedFrame onRetry={retry} /> : <BootFrame />}</div>;
}
