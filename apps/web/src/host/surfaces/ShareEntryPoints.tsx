// Where sharing starts outside the note's top bar (T2.4): a folder's context menu offers "Share…" to its owner, and a
// link visitor who is not signed in is offered "Sign in to do more", which returns to the same URL, link and all.
import { ContextMenuItem } from '@moss/shared/components/ui/context-menu';
import { Folder, LogIn, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuthState } from '../auth.ts';
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

/** For a share-link visitor with no session: sign in, then come back here with the link's ceiling lifted (A§8). */
export function SignInToDoMore(): ReactNode {
  const auth = useAuthState();
  if (auth.status !== 'signed-out') return null;
  const here = `${window.location.pathname}${window.location.search}`;
  return (
    <button
      type="button"
      data-collab-chrome=""
      onClick={() => leaveTo(`${LOGIN_PATH}?next=${encodeURIComponent(here)}`)}
      className="flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded px-2 text-xs text-ink-muted transition-colors hover:bg-surface-note-hover/40 hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
    >
      <LogIn aria-hidden className="h-3.5 w-3.5" />
      Sign in to do more
    </button>
  );
}

/** The current containing folder, when the owner can share it, also lives behind the note's quiet door. */
export function FolderShareControl({ docId }: { docId: string }): ReactNode {
  const workspace = getBridge()?.[WORKSPACE];
  const path = workspace?.getSnapshot()?.docs.find(doc => doc.id === docId)?.folderPath;
  const folder = path ? workspace?.folderAt(path) : null;
  if (!folder || folder.role !== 'owner') return null;
  return <button type="button" data-close-collaboration="" aria-label="Share folder" onClick={() => openShare({ type: 'folder', id: folder.id, name: folder.name, vault: false })}
    className="flex h-7 w-full items-center gap-2 rounded px-2 text-xs text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
    <Folder aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />Share folder…
  </button>;
}
