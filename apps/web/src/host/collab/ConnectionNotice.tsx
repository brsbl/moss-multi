import { CONNECTION_ATTR, CONNECTION_BANNER_ATTR, NOTICE_BAND_ATTR, type TerminalReason } from '@moss-multi/protocol/dom-contract';
import { TRASH_COPY } from '@moss-multi/protocol/retention';
import { Banner } from '../../../../../packages/ui/src/Banner.tsx';
import { RefusalAnnouncer } from '../surfaces/RefusalAnnouncer.tsx';
import { leaveTo } from '../navigation.ts';
import { useDocConnection } from './connection.ts';
import { retryDoc } from './doc-session.ts';
import { retrySuggest, useSuggestBusy } from './suggest/mode.ts';
import { useTerminal } from './terminal.ts';

const terminalCopy: Record<TerminalReason, string> = {
  deleted: TRASH_COPY.peerTrashed,
  revoked: 'Your access to this note has ended.',
  'session-ended': 'Your session has ended. Sign in again to continue.',
  unavailable: 'This note is unavailable.',
  'conn-limit': 'This note has reached its connection limit. Close another window, then retry.',
  // It reconnects by itself when the cooldown ends, delivering what the window still owes.
  'suggest-cooldown': 'Suggesting is paused for about a minute. What you typed is kept in this window, so don’t reload.',
};

/** A Suggest window the person's other Suggest windows leave no lease for. */
const SUGGEST_BUSY = 'This note is open for suggesting in other windows. Close one to suggest here.';

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

export function ConnectionNotice({ docId }: { docId: string | null }) {
  const view = useDocConnection(docId);
  const terminal = useTerminal(docId);
  const busy = useSuggestBusy(docId);
  const kind = terminal ?? (view?.retrying ? 'retrying' : view?.synced && view.connection === 'offline' ? 'offline' : busy ? 'suggest-busy' : null);
  const message = terminal ? terminalCopy[terminal] : kind === 'suggest-busy' ? SUGGEST_BUSY : (kind === 'retrying'
    ? 'Still connecting… Your note will open when sync finishes.'
    : 'Connection lost. Your edits are kept in this window and will sync when the connection returns.');
  const retry = (run: (id: string) => void) => <button type="button" className="underline" onClick={() => { if (docId) run(docId); }}>Retry</button>;
  return <div {...{ [NOTICE_BAND_ATTR]: '' }} className="relative z-10 shrink-0">
    {kind ? <Banner {...{ [CONNECTION_BANNER_ATTR]: kind }} action={terminal === 'conn-limit'
      ? retry(retryDoc)
      : kind === 'suggest-busy' ? retry(retrySuggest)
      : terminal === 'session-ended' ? <button type="button" className="underline" onClick={() => leaveTo(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)}>Sign in</button> : undefined}>{message}</Banner> : null}
    <RefusalAnnouncer />
  </div>;
}
