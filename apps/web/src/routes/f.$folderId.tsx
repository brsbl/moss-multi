import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { askFolderAccess } from '../host/access.ts';
import { useAccessGate } from '../host/access-gate.ts';
import { auth, requireSessionOrLink } from '../host/auth.ts';
import { BootFrame, MossAppHost } from '../host/MossAppHost.tsx';
import { DenialPage } from '../host/surfaces/DenialPage.tsx';
import { DegradedFrame, SessionPending } from '../host/surfaces/SessionFrame.tsx';

// The folder or vault share landing (A§4.2): the moss shell with that folder's vault active and the folder revealed
// (boot.tsx). A folder link opens it signed out, its folder the root of a link-scoped workspace. A folder the caller
// cannot open, or one that does not exist, gets the denial page.
export const Route = createFileRoute('/f/$folderId')({
  ssr: false,
  beforeLoad: requireSessionOrLink,
  pendingComponent: SessionPending,
  pendingMinMs: 0,
  component: FolderRoute,
});

function FolderRoute(): ReactNode {
  const { folderId } = Route.useParams();
  const { gate, retry } = useAccessGate(folderId, askFolderAccess);
  if (gate === 'open') return <MossAppHost />;
  if (gate === 'denied') return <DenialPage signedIn={auth.get().status === 'signed-in'} what="folder" />;
  return <div id="root">{gate === 'degraded' ? <DegradedFrame onRetry={retry} /> : <BootFrame />}</div>;
}
