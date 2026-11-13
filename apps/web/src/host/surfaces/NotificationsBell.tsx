// The bell (T2.8; A§11): in the note's top bar beside Share, the connection indicator and the face pile, so nothing
// floats over the canvas (L§1.3). It follows glyphdown's NotificationsBell (an unread count, "Mark all read", newest
// first) built from moss's DS menu and the InboxItem primitive, and it is pushed through the workspace channel rather
// than polled. A notice opens its item in place through navigation.ts and is marked read with keepalive.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { Bell } from 'lucide-react';
import { useRef, useSyncExternalStore, type ReactNode } from 'react';
import { InboxItem } from '../../../../../packages/ui/src/InboxItem.tsx';
import { useAuthState } from '../auth.ts';
import { inbox } from '../inbox.ts';
import { departTo, openDoc } from '../navigation.ts';
import type { Notice } from '../notifications.ts';

/** How many notices the open inbox lists. */
const SHOWN = 30;
const EMPTY: Notice[] = [];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Just now" only within the minute; a notice two days old reads as days, never as recent. */
export function timeAgo(at: number, now = Date.now()): string {
  const age = Math.max(0, now - at);
  if (age < MINUTE) return 'Just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 2 * DAY) return 'Yesterday';
  if (age < 7 * DAY) return `${Math.floor(age / DAY)} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Glyphdown's notice copy. */
export function noticeText(notice: Notice): string {
  const { title, kind } = notice.target;
  if (notice.type === 'mention') return `${notice.by} mentioned you in “${title}”`;
  if (notice.type === 'comment-reply') return `${notice.by} replied to your comment in “${title}”`;
  if (notice.type === 'suggestion') return `${notice.by} suggested changes in “${title}”`;
  if (notice.type === 'invite-accepted') {
    const via = notice.invitedEmail ? ` (invite sent to ${notice.invitedEmail})` : '';
    return `${notice.by} accepted your invite to “${title}”${via}`;
  }
  return kind === 'doc' ? `${notice.by} shared “${title}” with you` : `${notice.by} shared the ${kind} “${title}” with you`;
}

export function NotificationsBell({ inline = false, onOpen }: { inline?: boolean; onOpen?: () => void } = {}): ReactNode {
  const auth = useAuthState();
  const notices = useSyncExternalStore(inbox.subscribe, inbox.get, () => EMPTY);
  // A notice that navigates keeps focus from returning to the bell, where a typed Space or Enter would reopen it.
  const opening = useRef(false);
  if (auth.status !== 'signed-in') return null;
  const unread = notices.filter((n) => !n.read);

  const open = (notice: Notice) => {
    opening.current = true;
    inbox.markRead([notice.id]);
    if (notice.target.type === 'doc') openDoc(notice.target.id);
    else void departTo(`/f/${encodeURIComponent(notice.target.id)}`);
  };

  const content = <>
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
          <span className="text-xs font-medium text-ink-default">Notifications</span>
          {unread.length > 0 ? (
            <button type="button" onClick={() => inbox.markRead(unread.map((n) => n.id))} className="text-xs text-ink-muted transition-colors hover:text-ink-default">
              Mark all read
            </button>
          ) : null}
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {notices.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-ink-faint">No notifications yet.</p>
          ) : (
            notices.slice(0, SHOWN).map((notice) => inline ? (
              <button type="button" key={notice.id} onClick={() => open(notice)} className="flex w-full items-start rounded px-2 py-1.5 text-left outline-none hover:bg-surface-panel focus-visible:bg-surface-panel">
                <InboxItem unread={!notice.read} time={timeAgo(notice.createdAt)}>{noticeText(notice)}</InboxItem>
              </button>
            ) : (
              <DropdownMenuItem key={notice.id} onSelect={() => open(notice)} className="items-start">
                <InboxItem unread={!notice.read} time={timeAgo(notice.createdAt)}>{noticeText(notice)}</InboxItem>
              </DropdownMenuItem>
            ))
          )}
        </div>
  </>;
  if (inline) return <div>{content}</div>;
  if (onOpen) return <button type="button" onClick={onOpen} aria-label={unread.length ? `Notifications, ${unread.length} unread` : 'Notifications'}
    className="flex h-7 w-full items-center gap-2 rounded px-2 text-xs text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
    <Bell aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} /><span className="flex-1 text-left">Notifications</span>{unread.length > 0 && <span className="text-micro text-ink-faint">{unread.length} unread</span>}
  </button>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-collab-chrome=""
          aria-label={unread.length ? `Notifications, ${unread.length} unread` : 'Notifications'}
          className="flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded px-2 text-xs text-ink-muted transition-colors hover:bg-surface-note-hover/40 hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
        >
          <Bell aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span className="flex-1 text-left">Notifications</span>
          {unread.length > 0 && <span className="text-micro tabular-nums text-ink-faint">{unread.length} unread</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        onCloseAutoFocus={(event) => {
          if (!opening.current) return;
          opening.current = false;
          event.preventDefault();
        }}
      >
        {content}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
