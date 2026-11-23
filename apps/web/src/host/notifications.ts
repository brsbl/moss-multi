// The tab's notices for the bell (T2.8): read from `GET /api/notifications` at boot and whenever the workspace
// channel says they changed (A§5.2), never polled. Marking read updates the bell at once and sends the request with
// `keepalive`, unawaited, so opening a notice never waits on the network (A§9; L§4.6 navigation mid-typing).
// Signing out forgets them in the same tick.
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import { heldRead } from './leave';

export interface Notice {
  id: string;
  type: 'share-invite' | 'invite-accepted' | 'mention' | 'comment-reply' | 'suggestion';
  read: boolean;
  createdAt: number;
  by: string;
  target: { type: 'doc' | 'folder'; id: string; title: string; kind: 'doc' | 'folder' | 'vault' };
  invitedEmail?: string;
  /** The comment a mention or reply notice is about. */
  commentId?: string;
  /** The suggestion a suggestion notice is about. */
  suggestionId?: string;
}

/** Whether the list has been read: `loading` until the first answer (or a retry after a failure), `error` when no
 * answer has landed yet and the last read failed. A later failed read keeps what was shown, still `ready`. */
export type InboxStatus = 'loading' | 'ready' | 'error';

/** A note's (or folder's) notices together, by their existing target id; each keeps its own link and read state. */
export interface NoticeGroup { key: string; target: Notice['target']; notices: Notice[] }

/** Groups `list` (newest first) by target, in the order each target's newest notice appears. */
export function groupNotices(list: Notice[]): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();
  for (const notice of list) {
    const key = `${notice.target.type}:${notice.target.id}`;
    const group = groups.get(key);
    if (group) group.notices.push(notice);
    else groups.set(key, { key, target: notice.target, notices: [notice] });
  }
  return [...groups.values()];
}

/** Opens a notice's target and acknowledges it only once the target is reached; one that never opens stays unread and
 * is remembered as unreachable, so its row can say why. One the user left for another note before it opened stays
 * unread and says nothing. */
export async function openNotice(notice: Notice, deps: {
  open: (notice: Notice) => Promise<boolean | 'superseded'>; markRead: (ids: string[]) => void; unreachable: (id: string) => void;
}): Promise<boolean> {
  const reached = await deps.open(notice);
  if (reached === true) deps.markRead([notice.id]);
  else if (reached === false) deps.unreachable(notice.id);
  return reached === true;
}

export interface NotificationsDeps {
  fetch: typeof fetch;
  signedIn: () => boolean;
}

const RETRY_MS = 5_000;
/** Metadata pushes come in bursts (a move, a typing peer's updated_at); one read answers a burst. */
const META_COALESCE_MS = 1_000;

export function createNotifications({ fetch: fetcher, signedIn }: NotificationsDeps) {
  let list: Notice[] = [];
  let status: InboxStatus = 'loading';
  let unreachable: ReadonlySet<string> = new Set();
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let coalesced: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const publish = (next: Notice[], nextStatus: InboxStatus = status) => {
    list = next;
    status = nextStatus;
    emit();
  };
  const setStatus = (next: InboxStatus) => {
    if (status === next) return;
    status = next;
    emit();
  };

  async function refresh(): Promise<void> {
    if (retry) clearTimeout(retry);
    if (coalesced) clearTimeout(coalesced);
    retry = null;
    coalesced = null;
    const mine = ++generation;
    if (!signedIn()) {
      if (list.length) publish([]);
      return;
    }
    // A retry after a failed first read is pending again; a list already shown stays as it is.
    if (status === 'error') setStatus('loading');
    try {
      // A metadata push can land as the page reloads; the read is held by the leave (METHOD: WebKit page errors).
      const body = await heldRead(
        (signal) => {
          // A read held across a sign-out or a newer read is not sent when the page stays.
          if (mine !== generation || !signedIn()) return Promise.reject(new Error('superseded'));
          return fetcher('/api/notifications', { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store', signal });
        },
        async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return (await response.json()) as { notifications?: Notice[] };
        },
      );
      if (mine === generation && signedIn()) publish(body.notifications ?? [], 'ready');
    } catch {
      // The bell keeps what it showed and asks again; a push in the meantime asks sooner.
      if (mine === generation && signedIn()) {
        if (status === 'loading') setStatus('error');
        retry = setTimeout(() => void refresh(), RETRY_MS);
      }
    }
  }

  return {
    refresh,
    get: (): Notice[] => list,
    status: (): InboxStatus => status,
    /** Notices whose target did not open from the inbox (deleted, or access changed since the list was read). */
    unreachable: (): ReadonlySet<string> => unreachable,
    markUnreachable(id: string): void {
      if (unreachable.has(id)) return;
      unreachable = new Set([...unreachable, id]);
      emit();
    },
    unread: (): number => list.filter((n) => !n.read).length,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Marks `ids` read now; reading redeems nothing (an invite is redeemed only through its link, invites.ts). */
    markRead(ids: string[]): void {
      const marking = new Set(ids);
      if (!ids.length) return;
      // A read in flight answers with the old state; it must not bring the badge back.
      generation += 1;
      publish(list.map((n) => (marking.has(n.id) ? { ...n, read: true } : n)));
      void fetcher('/api/notifications/read', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ids }),
      }).catch(() => undefined);
    },
    /** The workspace channel (bridge): a push about notices, or a (re)connect that may have missed one. A metadata
     * push may mean the reader lost a note (a move), and the server lists notices by current access. */
    receive(event: WorkspaceEvent): void {
      if (event.type === 'notifications' || event.type === 'vaults') void refresh();
      else if (event.type === 'meta' && !coalesced && signedIn()) {
        coalesced = setTimeout(() => {
          coalesced = null;
          void refresh();
        }, META_COALESCE_MS);
      }
    },
    /** Sign-out: nothing is shown or asked for once the session is gone. */
    clear(): void {
      generation += 1;
      if (retry) clearTimeout(retry);
      if (coalesced) clearTimeout(coalesced);
      retry = null;
      coalesced = null;
      unreachable = new Set();
      publish([], 'loading');
    },
  };
}

export type Notifications = ReturnType<typeof createNotifications>;
