import { createFileRoute } from '@tanstack/react-router';
import { requireSession } from '../host/auth.ts';
import { MossAppHost } from '../host/MossAppHost.tsx';
import { SessionPending } from '../host/surfaces/SessionFrame.tsx';

// The moss shell on the active vault (A§4.2); T0.5b's bridge adds the last-viewed doc. The session is looked up
// in the browser (ssr: false), so a failed lookup degrades in place (R10) instead of failing the document.
export const Route = createFileRoute('/')({
  ssr: false,
  beforeLoad: requireSession,
  pendingComponent: SessionPending,
  pendingMinMs: 0,
  component: MossAppHost,
});
