// Substituted for apps/web's role cache (host/access.ts) in the editor bundle. A file-backed editor has no server to
// ask (its CSP allows no fetch): the person at the Mac owns their files, so every note answers 'owner', as desktop does.
import type { Role } from '@moss-multi/protocol/roles';

export interface AccessibleDoc {
  id: string;
  folderId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type DocAnswer = { kind: 'open'; role: Role; doc: AccessibleDoc } | { kind: 'denied' } | { kind: 'signed-out' } | { kind: 'unavailable' };

export function rememberRole(_docId: string, _role: unknown): void {}

export const knownRole = (_docId: string): Role | null => 'owner';

export const askDocAccess = (_docId: string): Promise<DocAnswer> => Promise.resolve({ kind: 'unavailable' });

export const askFolderAccess = (_folderId: string): Promise<{ kind: 'open' | 'denied' | 'signed-out' | 'unavailable' }> =>
  Promise.resolve({ kind: 'unavailable' });

export const useDocRole = (docId: string | null): Role | null => (docId ? 'owner' : null);

export const ACCESS_RETRY_MS: number[] = [];
