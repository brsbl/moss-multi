// The inbox (T2.8; A§11): always in the sidebar's app menu, and as a quiet bell in the note's top bar while something
// is unread (T9.30), so nothing floats over the canvas (L§1.3). It follows glyphdown's NotificationsBell ("Mark all
// read", newest first) built from moss's DS menu and the InboxItem primitive, and it is pushed through the workspace
// channel rather than polled. A notice opens its item in place through navigation.ts and is marked read with keepalive.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider } from '@moss/shared/components/ui/tooltip';
import { Bell } from 'lucide-react';
import { useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode, type RefObject } from 'react';
import { InboxItem } from '../../../../../packages/ui/src/InboxItem.tsx';
import { useAuthState } from '../auth.ts';
import { inbox } from '../inbox.ts';
import { departTo, openDoc } from '../navigation.ts';
import { footerDestination, handOffWhenGone, HomeTrigger, useFocusHome } from './footer.ts';
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

// moss's DropdownMenu is Base UI's Menu root, which takes a controlled `open`.
const Menu = DropdownMenu as ComponentType<{ children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }>;

/** The signed-in person's notices, newest first; empty for anyone else. */
function useNotices(): Notice[] {
  const auth = useAuthState();
  const notices = useSyncExternalStore(inbox.subscribe, inbox.get, () => EMPTY);
  return auth.status === 'signed-in' ? notices : EMPTY;
}

/** How many notices are unread: the top bar's bell shows only while there are some (T9.30). */
export function useUnreadCount(): number {
  return useNotices().filter((n) => !n.read).length;
}

/**
 * The top bar's unread shortcut: a quiet bell, only while something is unread and the bar has room (`show`). Once
 * opened it stays until the inbox closes; if it then leaves, focus goes to the inbox's own home, the sidebar footer's
 * Settings (through the notes-panel toggle in `bar` while the sidebar is hidden).
 */
export function NotificationsBell({ show = true, bar }: { show?: boolean; bar?: RefObject<HTMLElement | null> }): ReactNode {
  const auth = useAuthState();
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const navigating = useRef(false);
  // Focused when it leaves, unopened, it hands focus to the inbox's home too.
  const focusHome = useFocusHome(() => footerDestination(bar?.current ?? null));
  const leaving = !show || unread === 0;
  if (auth.status !== 'signed-in' || (!open && leaving)) return null;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) navigating.current = false;
    if (next || !bar?.current) return;
    // The bell may leave with its inbox, now or once the read marks land: focus then goes to the inbox's own home.
    const destination = footerDestination(bar.current);
    handOffWhenGone(bar.current, 'button[aria-label^="Notifications"]', () => destination, () => navigating.current);
  };
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <TooltipProvider>
        <Tooltip>
          <HomeTrigger asChild ref={focusHome}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-collab-chrome=""
                aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
              >
                <Bell aria-hidden className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </HomeTrigger>
          {open ? null : <TooltipContent side="bottom">Notifications</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
      <InboxContent align="end" onOpenNotice={() => { navigating.current = true; }} />
    </Menu>
  );
}

/** The inbox opened from the app menu, at `anchor` (the sidebar's Settings), which gets focus back on close. */
export function InboxMenu({ open, onOpenChange, anchor }: {
  open: boolean; onOpenChange: (open: boolean) => void; anchor: RefObject<HTMLElement | null>;
}): ReactNode {
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <InboxContent align="start" side="top" anchor={anchor} />
    </Menu>
  );
}

function InboxContent({ align, side = 'bottom', anchor, onOpenNotice }: {
  align: 'start' | 'end'; side?: 'top' | 'bottom'; anchor?: RefObject<HTMLElement | null>; onOpenNotice?: () => void;
}): ReactNode {
  const notices = useNotices();
  // A notice that navigates keeps focus from returning to the bell, where a typed Space or Enter would reopen it.
  const opening = useRef(false);
  const unread = notices.filter((n) => !n.read);

  const open = (notice: Notice) => {
    opening.current = true;
    onOpenNotice?.();
    inbox.markRead([notice.id]);
    if (notice.target.type === 'doc') openDoc(notice.target.id);
    else void departTo(`/f/${encodeURIComponent(notice.target.id)}`);
  };

  return (
      <DropdownMenuContent
        align={align}
        side={side}
        anchor={anchor}
        collisionPadding={16}
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        onCloseAutoFocus={(event) => {
          if (opening.current) {
            opening.current = false;
            event.preventDefault();
            return;
          }
          if (anchor?.current) {
            event.preventDefault();
            anchor.current.focus();
          }
        }}
      >
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
            notices.slice(0, SHOWN).map((notice) => (
              <DropdownMenuItem key={notice.id} onSelect={() => open(notice)} className="items-start">
                <InboxItem unread={!notice.read} time={timeAgo(notice.createdAt)}>{noticeText(notice)}</InboxItem>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
  );
}
