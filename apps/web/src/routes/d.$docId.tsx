import { createFileRoute } from '@tanstack/react-router';
import { requireSession } from '../host/auth.ts';
import { MossAppHost } from '../host/MossAppHost.tsx';
import { SessionPending } from '../host/surfaces/SessionFrame.tsx';

// The moss shell with the doc open: the bridge hands $docId to App as its window-context startup note (A§4.2).
// Signed out, it goes to /login?next= and back here after sign-in.
export const Route = createFileRoute('/d/$docId')({
  ssr: false,
  beforeLoad: requireSession,
  pendingComponent: SessionPending,
  pendingMinMs: 0,
  component: MossAppHost,
});
