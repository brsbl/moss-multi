import { CONNECTION_ATTR, CONNECTION_BANNER_ATTR, NOTICE_BAND_ATTR, type TerminalReason } from '@moss-multi/protocol/dom-contract';
import { TRASH_COPY } from '@moss-multi/protocol/retention';
import { Banner } from '../../../../../packages/ui/src/Banner.tsx';
import { RefusalAnnouncer } from '../surfaces/RefusalAnnouncer.tsx';
import { SESSION_ENDED_COPY, useSessionEnded } from '../session-fetch.ts';
import { leaveTo } from '../navigation.ts';
import { reloadUnlessUnacked } from '../reload-guard.ts';
import { useDocConnection } from './connection.ts';
import { retryDoc } from './doc-session.ts';
import { useTerminal } from './terminal.ts';

/** Moss's top bar without its controls (TopNavControls TOP_NAV_BAR_BASE_CLASSNAME), for a band with no note open. */
const TOP_BAR_FRAME = 'shrink-0 border-b border-border-subtle/30 px-panel-inset pt-panel-drag-top pb-1';

const terminalCopy: Record<TerminalReason, string> = {
  deleted: TRASH_COPY.peerTrashed,
  revoked: 'Your access to this note has ended.',
  'session-ended': SESSION_ENDED_COPY,
  unavailable: 'This note is unavailable.',
  'conn-limit': 'This note has reached its connection limit. Close another window, then retry.',
  outdated: 'Moss has been updated. Reload to keep editing.',
};

function terminalAction(terminal: TerminalReason | null, docId: string | null) {
  switch (terminal) {
    case 'conn-limit':
      return <button type="button" className="underline" onClick={() => { if (docId) retryDoc(docId); }}>Retry</button>;
    case 'session-ended':
      return <button type="button" className="underline" onClick={() => leaveTo(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)}>Sign in</button>;
    // This bundle can no longer write; the reload loads the deployed one, asking first while edits are unacked.
    case 'outdated':
      return <button type="button" className="underline" onClick={reloadUnlessUnacked}>Reload</button>;
    default:
      return undefined;
  }
}

export function ConnectionIndicator({ docId }: { docId: string }) {
  const view = useDocConnection(docId);
  const terminal = useTerminal(docId);
  const connection = terminal ? 'offline' : (view?.connection ?? 'reconnecting');
  const label = terminal ? 'Disconnected' : connection === 'online' ? 'Connected' : connection === 'offline' ? 'Offline' : 'Connecting…';
  return <span data-collab-chrome="" {...{ [CONNECTION_ATTR]: connection }} title={label} aria-label={label}
    className="flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle px-2 py-0.5 text-micro text-ink-muted">
    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${connection === 'online' ? 'bg-highlight-chalk-green' : 'bg-accent-terracotta'}`} />
    <span className="hidden sm:inline">{label}</span>
  </span>;
}

/** `bare`: no note is open, so no top bar sits above the band; an empty one keeps it clear of the window's drag strip
 * and in the place it has when a note is open. */
export function ConnectionNotice({ docId, bare = false }: { docId: string | null; bare?: boolean }) {
  const view = useDocConnection(docId);
  // A session that ended under this tab says so here too when no note is open, or before its note's socket ends.
  const ended = useSessionEnded();
  const terminal = useTerminal(docId) ?? (ended ? 'session-ended' : null);
  const kind = terminal ?? (view?.retrying ? 'retrying' : view?.synced && view.connection === 'offline' ? 'offline' : null);
  const message = terminal ? terminalCopy[terminal] : (kind === 'retrying'
    ? 'Still connecting… Your note will open when sync finishes.'
    : 'Connection lost. Your edits are kept in this window and will sync when the connection returns.');
  return <div {...{ [NOTICE_BAND_ATTR]: '' }} className="relative z-10 shrink-0">
    {kind && bare ? <div aria-hidden className={TOP_BAR_FRAME}><div className="h-8" /></div> : null}
    {kind ? <Banner {...{ [CONNECTION_BANNER_ATTR]: kind }} action={terminalAction(terminal, docId)}>{message}</Banner> : null}
    <RefusalAnnouncer />
  </div>;
}
