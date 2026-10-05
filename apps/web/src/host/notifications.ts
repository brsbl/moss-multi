// The tab's notices for the bell (T2.8). Tests-first stub: the store is not built yet.
export interface Notice {
  id: string;
  type: 'share-invite' | 'invite-accepted';
  read: boolean;
  createdAt: number;
  by: string;
  target: { type: 'doc' | 'folder'; id: string; title: string; kind: 'doc' | 'folder' | 'vault' };
  invitedEmail?: string;
}

export function createNotifications(deps: { fetch: typeof fetch; signedIn: () => boolean }) {
  void deps;
  return {
    refresh: async (): Promise<void> => undefined,
    get: (): Notice[] => [],
    unread: (): number => 0,
    markRead: (ids: string[], open?: string): void => void [ids, open],
  };
}
