import { Popover } from '@moss/shared/primitives';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { ArrowLeft, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FacePile } from '../../../../../packages/ui/src/FacePile.tsx';
import { usePeers } from '../collab/presence.ts';
import { CONNECTION_ATTR } from '@moss-multi/protocol/dom-contract';
import { useTerminal } from '../collab/terminal.ts';
import { useDocConnection } from '../collab/connection.ts';
import { ConnectionIndicator } from '../collab/ConnectionNotice.tsx';
import { useAuthState } from '../auth.ts';
import { useDocRole } from '../access.ts';
import { useSuggestionPanelOpen, closePanel } from '../collab/suggest/SuggestionsPanel.tsx';
import { NotificationsBell } from './NotificationsBell.tsx';
import { ShareControl } from './ShareDialog.tsx';
import { FolderShareControl, SignInToDoMore } from './ShareEntryPoints.tsx';
import { VaultSwitcher } from './VaultSwitcher.tsx';

/** One Moss-sized entry. Membership, activity and live presence stay distinct inside. */
export function CollaborationDoor({ docId, children, suggestions }: { docId: string; children?: ReactNode; suggestions?: ReactNode }) {
  const back = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const terminal = useTerminal(docId);
  const auth = useAuthState();
  const signedIn = auth.status === 'signed-in';
  const peers = usePeers(docId);
  const connection = useDocConnection(docId);
  const role = useDocRole(docId);
  const suggestionsOpen = useSuggestionPanelOpen(docId);
  // Clicking a proposal in the document must still open its card, even with the door closed.
  useEffect(() => { if (suggestionsOpen) setOpen(true); }, [suggestionsOpen]);
  const socketState = terminal ? 'offline' : connection?.connection ?? 'reconnecting';
  const detail = suggestionsOpen || inboxOpen;
  useEffect(() => { if (detail) back.current?.focus(); }, [detail]);
  const label = `Collaboration${peers.length ? `, ${peers.length} others here` : ''}${socketState === 'offline' ? ', offline' : socketState === 'reconnecting' ? ', connecting' : ''}`;
  return <TooltipProvider><Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) { closePanel(docId); setInboxOpen(false); } }}>
    <Tooltip><TooltipTrigger asChild><Popover.Trigger asChild>
      <button type="button" data-collab-chrome="" data-collaboration-door="" {...{ [CONNECTION_ATTR]: socketState }} aria-label={label}
        className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 ${open ? 'bg-surface-note-hover/40 text-ink-muted' : ''}`}>
        <Users aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
        {peers.length > 0 && <span className="pointer-events-none absolute -bottom-0.5 right-0"><FacePile peers={peers} compact /></span>}
      </button>
    </Popover.Trigger></TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip>
    <Popover.Portal><Popover.Content align="end" side="bottom" sideOffset={6} collisionPadding={16}
      onPointerDownOutside={(event) => { if (document.querySelector('[data-remote-web-surface-blocking-dialog]')) event.preventDefault(); }}
      onEscapeKeyDown={(event) => { if (document.querySelector('[data-remote-web-surface-blocking-dialog]')) event.preventDefault(); }}
      onFocusOutside={(event) => { if (document.querySelector('[data-remote-web-surface-blocking-dialog]')) event.preventDefault(); }}
      data-collaboration-panel="" className={`z-50 ${detail ? 'w-comment-list-popover' : 'w-60'} max-w-[calc(100vw-2rem)] rounded-lg border border-border-subtle bg-surface-floating p-1 shadow-surface outline-none`}>
      {detail && <button ref={back} type="button" aria-label="Back to collaboration" onClick={(event) => {
        const panel = event.currentTarget.closest('[data-collaboration-panel]');
        closePanel(docId); setInboxOpen(false);
        requestAnimationFrame(() => panel?.querySelector<HTMLButtonElement>('button')?.focus());
      }} className="flex h-7 items-center gap-2 rounded px-2 text-xs text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"><ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />Collaboration</button>}
      {detail && <Popover.Title className="sr-only">{suggestionsOpen ? 'Suggestions' : 'Notifications'}</Popover.Title>}
      {!detail && <>
      <div className="px-2 py-2">
        <Popover.Title className="text-xs font-medium text-ink-default">Collaboration</Popover.Title>
        <div className="mt-1 flex items-center justify-between gap-2 text-micro text-ink-muted"><ConnectionIndicator docId={docId} /><span>{role === 'viewer' ? 'View only' : role === 'commenter' ? 'Can comment' : role === 'suggester' ? 'Can suggest' : role === 'owner' ? 'Owner' : 'Can edit'}</span></div>
      </div>
      {signedIn && <div className="border-t border-border-subtle px-2 py-2">
        <p className="mb-1 text-micro text-ink-faint">{peers.length ? 'Here now' : 'Only you here'}</p>
        {peers.map(peer => <div key={peer.clientId} className="flex items-center gap-2 py-1 text-xs text-ink-muted"><FacePile peers={[peer]} /><span className="min-w-0 truncate">{peer.name}{peer.isAgent ? ' · agent' : ''}</span></div>)}
      </div>}
      </>}
      <div className="flex flex-col gap-0.5 py-1" onClick={(event) => {
        if ((event.target as Element).closest('[data-close-collaboration]')) setOpen(false);
      }}>
        {!detail && <><ShareControl docId={docId} /><FolderShareControl docId={docId} /></>}
        {!inboxOpen && suggestions}
        {!detail && children}
        {!suggestionsOpen && <NotificationsBell inline={inboxOpen} onOpen={() => setInboxOpen(true)} />}
        {!detail && <SignInToDoMore />}
      </div>
      {!detail && signedIn && <div className="border-t border-border-subtle pt-1"><VaultSwitcher inCollaboration /></div>}
    </Popover.Content></Popover.Portal>
  </Popover.Root></TooltipProvider>;
}
