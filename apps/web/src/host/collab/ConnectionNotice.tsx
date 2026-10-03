import { CONNECTION_ATTR, CONNECTION_BANNER_ATTR, NOTICE_BAND_ATTR, type TerminalReason } from '@moss-multi/protocol/dom-contract';
import { Banner } from '../../../../../packages/ui/src/Banner.tsx';
import { RefusalAnnouncer } from '../surfaces/RefusalAnnouncer.tsx';
import { useDocConnection } from './connection.ts';
import { retryDoc } from './doc-session.ts';
import { useTerminal } from './terminal.ts';

const terminalCopy: Record<TerminalReason, string> = {
  deleted: 'This note was deleted.',
  revoked: 'Your access to this note has ended.',
  'session-ended': 'Your session has ended. Sign in again to continue.',
  unavailable: 'This note is unavailable.',
  'conn-limit': 'This note has reached its connection limit. Close another window, then retry.',
};

export function ConnectionIndicator({ docId }: { docId: string }) {
  const view = useDocConnection(docId);
  const terminal = useTerminal(docId);
  const connection = terminal ? 'offline' : (view?.connection ?? 'reconnecting');
  const label = terminal ? 'Disconnected' : connection === 'online' ? 'Connected' : connection === 'offline' ? 'Offline' : 'Connecting…';
  return <span {...{ [CONNECTION_ATTR]: connection }} title={label} aria-label={label}
    className="flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle px-2 py-0.5 text-micro text-ink-muted">
    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${connection === 'online' ? 'bg-chalk-green' : 'bg-accent-terracotta'}`} />
    <span className="hidden sm:inline">{label}</span>
  </span>;
}

export function ConnectionNotice({ docId }: { docId: string | null }) {
  const view = useDocConnection(docId);
  const terminal = useTerminal(docId);
  const kind = terminal ?? (view?.halted ? 'halted' : view?.retrying ? 'retrying' : view?.synced && view.connection === 'offline' ? 'offline' : null);
  const message = terminal ? terminalCopy[terminal] : view?.halted ?? (kind === 'retrying'
    ? 'Still connecting… Your note will open when sync finishes.'
    : 'Connection lost. Your edits are kept in this window and will sync when the connection returns.');
  return <div {...{ [NOTICE_BAND_ATTR]: '' }} className="relative z-10 shrink-0">
    {kind ? <Banner {...{ [CONNECTION_BANNER_ATTR]: kind }} action={terminal === 'conn-limit'
      ? <button type="button" className="underline" onClick={() => { if (docId) retryDoc(docId); }}>Retry</button>
      : terminal === 'session-ended' ? <a href="/login" className="underline">Sign in</a> : undefined}>{message}</Banner> : null}
    <RefusalAnnouncer />
  </div>;
}
