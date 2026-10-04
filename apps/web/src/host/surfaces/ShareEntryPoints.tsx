// Where sharing starts outside the note's top bar (T2.4): a folder's context menu offers "Share…" to its owner, and a
// link visitor who is not signed in is offered "Sign in to do more", which returns to the same URL, link and all.
import { ContextMenuItem } from '@moss/shared/components/ui/context-menu';
import { LogIn, UserPlus } from 'lucide-react';
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
      className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs font-medium text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
    >
      <LogIn aria-hidden className="h-3.5 w-3.5" />
      Sign in to do more
    </button>
  );
}
