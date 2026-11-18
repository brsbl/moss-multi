// Where sharing starts outside the note's top bar (T2.4): a folder's context menu offers "Share…" to its owner, and a
// link visitor who is not signed in is offered "Sign in to do more", which returns to the same URL, link and all.
import { ContextMenuItem } from '@moss/shared/components/ui/context-menu';
import { UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { LOGIN_PATH } from '../auth-state.ts';
import { getBridge, WORKSPACE } from '../bridge/index.ts';
import { leaveTo } from '../navigation.ts';
import { openShare } from './ShareDialog.tsx';

/** "Share…" in a folder's context menu; only the folder's owner shares it (A§8). */
export function FolderShareItem({ folderPath }: { folderPath: string }): ReactNode {
  const folder = getBridge()?.[WORKSPACE].folderAt(folderPath);
  if (!folder || folder.role !== 'owner') return null;
  return (
    <ContextMenuItem onSelect={() => openShare({ type: 'folder', id: folder.id, name: folder.name, vault: false })}>
      <UserPlus className="h-3.5 w-3.5 text-ink-muted" />
      <span>Share…</span>
    </ContextMenuItem>
  );
}

/** Sign in, then come back here, link and all. */
export function signInToDoMore(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  leaveTo(`${LOGIN_PATH}?next=${encodeURIComponent(here)}`);
}
