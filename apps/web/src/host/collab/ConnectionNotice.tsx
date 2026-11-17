import { CONNECTION_ATTR, CONNECTION_BANNER_ATTR, NOTICE_BAND_ATTR, type ConnectionState, type TerminalReason } from '@moss-multi/protocol/dom-contract';
import { TRASH_COPY } from '@moss-multi/protocol/retention';
import { Banner } from '../../../../../packages/ui/src/Banner.tsx';
import { RefusalAnnouncer } from '../surfaces/RefusalAnnouncer.tsx';
import { leaveTo } from '../navigation.ts';
import { reloadUnlessUnacked } from '../reload-guard.ts';
import { useDocConnection } from './connection.ts';
import { retryDoc } from './doc-session.ts';
import { useTerminal } from './terminal.ts';

const terminalCopy: Record<TerminalReason, string> = {
  deleted: TRASH_COPY.peerTrashed,
  revoked: 'Your access to this note has ended.',
  'session-ended': 'Your session has ended. Sign in again to continue.',
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

/** The note's connection in words, and its DOM-contract state. */
export function useConnectionState(docId: string | null): { connection: ConnectionState; label: string } {
  const view = useDocConnection(docId);
  const terminal = useTerminal(docId);
  const connection: ConnectionState = terminal ? 'offline' : (view?.connection ?? 'reconnecting');
  const label = terminal ? 'Disconnected' : connection === 'online' ? 'Connected' : connection === 'offline' ? 'Offline' : 'Connecting…';
  return { connection, label };
}

/**
 * The pane's connection, published in its top bar for the DOM contract and assistive tech. It draws nothing: a healthy
 * connection is quiet, trouble shows in the notice band, and details are in the app menu's Connection status (T9.30).
 */
export function ConnectionIndicator({ docId }: { docId: string }) {
  const { connection, label } = useConnectionState(docId);
  return <span {...{ [CONNECTION_ATTR]: connection }} role="status" className="sr-only">{label}</span>;
}

export function ConnectionNotice({ docId }: { docId: string | null }) {
  const view = useDocConnection(docId);
  const terminal = useTerminal(docId);
  const kind = terminal ?? (view?.retrying ? 'retrying' : view?.synced && view.connection === 'offline' ? 'offline' : null);
  const message = terminal ? terminalCopy[terminal] : (kind === 'retrying'
    ? 'Still connecting… Your note will open when sync finishes.'
    : 'Connection lost. Your edits are kept in this window and will sync when the connection returns.');
  return <div {...{ [NOTICE_BAND_ATTR]: '' }} className="relative z-10 shrink-0">
    {kind ? <Banner {...{ [CONNECTION_BANNER_ATTR]: kind }} action={terminalAction(terminal, docId)}>{message}</Banner> : null}
    <RefusalAnnouncer />
  </div>;
}
