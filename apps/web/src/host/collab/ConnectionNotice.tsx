// The note's connection (T9.40): a healthy connection draws nothing. An outage, a late first sync or a terminal close
// floats as Moss's bottom notice in the pane's bottom region, never as a strip that moves the note; a write waiting
// for its ack past PENDING_CUE_AFTER_MS shows one quiet cue there instead. The details (state, whether changes are
// saved, and Retry where a retry is supported) open from the cue and from the app menu's Connection status. Which
// card leads the region, the connection's or another notice's, is NoticeStack's to decide (T9.41).
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import {
  CONNECTION_ATTR, CONNECTION_BANNER_ATTR, CONNECTION_CUE_ATTR, type ConnectionBanner, type ConnectionState, type TerminalReason,
} from '@moss-multi/protocol/dom-contract';
import { TRASH_COPY } from '@moss-multi/protocol/retention';
import { AlertTriangle, Cloud, CloudOff, CloudUpload } from 'lucide-react';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Banner } from '../../../../../packages/ui/src/Banner.tsx';
import { SESSION_ENDED_COPY, useSessionEnded } from '../session-fetch.ts';
import { leaveTo } from '../navigation.ts';
import { NOTICE_ACTION as ACTION } from '../notice-stack.ts';
import { reloadUnlessUnacked } from '../reload-guard.ts';
import { holdCue, useDocConnection, useUnacked, type Cue } from './connection.ts';
import { retryDoc } from './doc-session.ts';
import { useTerminal } from './terminal.ts';

const Menu = DropdownMenu as ComponentType<{ children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }>;

const terminalCopy: Record<TerminalReason, string> = {
  deleted: TRASH_COPY.peerTrashed,
  revoked: 'Your access to this note has ended.',
  'session-ended': SESSION_ENDED_COPY,
  unavailable: 'This note is unavailable.',
  'conn-limit': 'This note has reached its connection limit. Close another window, then retry.',
  outdated: 'Moss has been updated. Reload to keep editing.',
};

const ICON = 'h-3.5 w-3.5 shrink-0';
const HEADING = 'px-2 py-1.5 text-xs font-normal text-ink-faint';

function terminalAction(terminal: TerminalReason | null, docId: string | null) {
  switch (terminal) {
    case 'conn-limit':
      return <button type="button" className={ACTION} onClick={() => { if (docId) retryDoc(docId); }}>Retry</button>;
    case 'session-ended':
      return <button type="button" className={ACTION} onClick={() => leaveTo(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)}>Sign in</button>;
    // This bundle can no longer write; the reload loads the deployed one, asking first while edits are unacked.
    case 'outdated':
      return <button type="button" className={ACTION} onClick={reloadUnlessUnacked}>Reload</button>;
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
 * connection is quiet, trouble shows in the bottom region, and details are in the app menu's Connection status.
 */
export function ConnectionIndicator({ docId }: { docId: string }) {
  const { connection, label } = useConnectionState(docId);
  return <span {...{ [CONNECTION_ATTR]: connection }} role="status" className="sr-only">{label}</span>;
}

export type ConnectionNoticeView = NonNullable<ReturnType<typeof useNotice>>;

/** What needs saying about the connection now, if anything: these never wait for the cue's delay. */
export function useNotice(docId: string | null): { kind: ConnectionBanner; terminal: TerminalReason | null; message: string } | null {
  const view = useDocConnection(docId);
  // A session that ended under this tab says so here too when no note is open, or before its note's socket ends.
  const ended = useSessionEnded();
  const terminal = useTerminal(docId) ?? (ended ? 'session-ended' : null);
  const kind = terminal ?? (view?.retrying ? 'retrying' : view?.synced && view.connection === 'offline' ? 'offline' : null);
  if (!kind) return null;
  const message = terminal ? terminalCopy[terminal] : (kind === 'retrying'
    ? 'Still connecting… Your note will open when sync finishes.'
    : 'Connection lost. Your edits are kept in this window and will sync when the connection returns.');
  return { kind, terminal, message };
}

/** The connection's card; `extra` holds the actions for what it leads over (T9.41), its own action first. */
export function NoticeCard({ docId, notice, extra }: { docId: string | null; notice: ConnectionNoticeView; extra?: ReactNode }): ReactNode {
  const icon = notice.terminal
    ? <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-accent-terracotta/80" /* Moss's Trash notice icon */ />
    : <CloudOff aria-hidden className={`${ICON} text-ink-faint`} />;
  const own = terminalAction(notice.terminal, docId);
  return (
    <Banner {...{ [CONNECTION_BANNER_ATTR]: notice.kind }} icon={icon} action={own || extra ? <>{extra}{own}</> : undefined}>
      {notice.message}
    </Banner>
  );
}

/** The connection details, inside a menu: the state in words, whether changes are saved, and a supported Retry. */
export function ConnectionDetails({ docId }: { docId: string | null }): ReactNode {
  const { label } = useConnectionState(docId);
  const view = useDocConnection(docId);
  const terminal = useTerminal(docId);
  const unacked = useUnacked(docId);
  const saved = !docId
    ? null
    : unacked
      ? (terminal ? 'Changes not saved' : view?.connection === 'online' ? 'Saving changes…' : 'Changes kept in this window until it reconnects')
      : view?.synced && !terminal ? 'All changes saved' : null;
  return (
    <>
      <DropdownMenuLabel className={HEADING}>Connection status</DropdownMenuLabel>
      <div role="status" className="px-2 py-1.5 text-xs">
        <div className="flex items-center gap-2 text-ink-default">
          <Cloud aria-hidden className={`${ICON} text-ink-faint`} />
          {docId ? label : 'No note open'}
        </div>
        {saved ? <div className="mt-0.5 pl-[22px] text-ink-faint">{saved}</div> : null}
      </div>
      {docId && terminal === 'conn-limit' ? (
        <DropdownMenuItem className="gap-2 text-xs" onSelect={() => retryDoc(docId)}>Retry</DropdownMenuItem>
      ) : null}
    </>
  );
}

/**
 * The quiet cue: Moss's faint status line with a cloud, “Saving…” (or “Reconnecting…” while the socket is down) once
 * a write has waited, then the bare cloud for the idle second after the ack. It opens the details, and holds its place
 * while they are open or it has focus, so a focused control never vanishes under the keyboard.
 */
export function PendingCue({ docId, cue }: { docId: string; cue: Exclude<Cue, 'hidden'> }): ReactNode {
  const view = useDocConnection(docId);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    holdCue(docId, open || focused);
  }, [docId, open, focused]);
  useEffect(() => () => holdCue(docId, false), [docId]);
  const words = cue === 'pending' ? (view?.connection === 'online' ? 'Saving…' : 'Reconnecting…') : null;
  return (
    <div {...{ [CONNECTION_CUE_ATTR]: cue }} role="status" className="pointer-events-auto">
      <Menu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={words ?? 'Connection status'}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-xs text-ink-faint transition-colors hover:text-ink-muted"
          >
            <CloudUpload aria-hidden className={ICON} />
            {words ? <span>{words}</span> : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" sideOffset={6} collisionPadding={16} className="min-w-0 w-max max-w-[calc(100vw-2rem)]">
          <ConnectionDetails docId={docId} />
        </DropdownMenuContent>
      </Menu>
    </div>
  );
}
