// The tab's notices for the bell (T2.8): read from `GET /api/notifications` at boot and whenever the workspace
// channel says they changed (A§5.2), never polled. Marking read updates the bell at once and sends the request with
// `keepalive`, unawaited, so opening a notice never waits on the network (A§9; L§4.6 navigation mid-typing).
// Signing out forgets them in the same tick.
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';

export interface Notice {
  id: string;
  type: 'share-invite' | 'invite-accepted' | 'mention' | 'comment-reply';
  read: boolean;
  createdAt: number;
  by: string;
  target: { type: 'doc' | 'folder'; id: string; title: string; kind: 'doc' | 'folder' | 'vault' };
  invitedEmail?: string;
  /** The comment a mention or reply notice is about. */
  commentId?: string;
}

export interface NotificationsDeps {
  fetch: typeof fetch;
  signedIn: () => boolean;
}

const RETRY_MS = 5_000;

export function createNotifications({ fetch: fetcher, signedIn }: NotificationsDeps) {
  let list: Notice[] = [];
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Notice[]) => {
    list = next;
    for (const listener of listeners) listener();
  };

  async function refresh(): Promise<void> {
    if (retry) clearTimeout(retry);
    retry = null;
    const mine = ++generation;
    if (!signedIn()) {
      if (list.length) publish([]);
      return;
    }
    try {
      const response = await fetcher('/api/notifications', { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { notifications?: Notice[] };
      if (mine === generation && signedIn()) publish(body.notifications ?? []);
    } catch {
      // The bell keeps what it showed and asks again; a push in the meantime asks sooner.
      if (mine === generation && signedIn()) retry = setTimeout(() => void refresh(), RETRY_MS);
    }
  }

  return {
    refresh,
    get: (): Notice[] => list,
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
    /** The workspace channel (bridge): a push about notices, or a (re)connect that may have missed one. */
    receive(event: WorkspaceEvent): void {
      if (event.type === 'notifications' || event.type === 'vaults') void refresh();
    },
    /** Sign-out: nothing is shown or asked for once the session is gone. */
    clear(): void {
      generation += 1;
      if (retry) clearTimeout(retry);
      retry = null;
      if (list.length) publish([]);
    },
  };
}

export type Notifications = ReturnType<typeof createNotifications>;
