// The vault's name where a signed-in person works (T9.31): the tab, the note's location and "+ Note" name it, so the
// vault on screen is known without a header control. A link visitor is shown no vault name. The vendored notes list
// and location read this, so it takes who is signed in from boot rather than importing the auth module.
import { useSyncExternalStore } from 'react';
import { getBridge, WORKSPACE } from './bridge/index.ts';

let signedIn = false;
const signedInListeners = new Set<() => void>();
/** Boot reports whether a person is signed in. */
export function setSignedIn(next: boolean): void {
  if (next === signedIn) return;
  signedIn = next;
  for (const listener of signedInListeners) listener();
}
const subscribeSignedIn = (listener: () => void) => {
  signedInListeners.add(listener);
  return () => { signedInListeners.delete(listener); };
};
const useSignedIn = () => useSyncExternalStore(subscribeSignedIn, () => signedIn, () => false);

const noSubscribe = () => () => {};
const noSnapshot = () => null;

function useWorkspace() {
  const bridge = getBridge() ?? null;
  return useSyncExternalStore(bridge?.[WORKSPACE].subscribe ?? noSubscribe, bridge?.[WORKSPACE].getSnapshot ?? noSnapshot, noSnapshot);
}

/** The vault on screen, for a signed-in person; null for a link visitor. */
export function useVaultName(): string | null {
  const isSignedIn = useSignedIn();
  const workspace = useWorkspace();
  return isSignedIn ? workspace?.vault.name ?? null : null;
}

/**
 * The vault on screen only when note `id` is known to live in it: listed there, not surfaced as shared directly and
 * not under a surfaced shared folder (A§11). Otherwise null, so a name is never guessed.
 */
export function useVaultOfNote(id: string | null): string | null {
  const name = useVaultName();
  const workspace = useWorkspace();
  const doc = id ? workspace?.docs.find((entry) => entry.id === id) : undefined;
  if (!name || !doc || doc.surfaced) return null;
  return underSurfaced(workspace, doc.folderPath ?? '') ? null : name;
}

/** A folder path that is, or sits under, a folder surfaced from another vault. */
function underSurfaced(workspace: ReturnType<typeof useWorkspace>, path: string): boolean {
  return workspace?.folders?.some((folder) => folder.surfaced &&
    (path === folder.path || path.startsWith(`${folder.path}/`))) ?? false;
}

/**
 * "+ Note"'s tooltip for a note created in `folderPath` (noteTargetFolder's answer): the vault on screen, or null when
 * that folder was shared from another vault, whose name is not known here.
 */
export function useNewNoteHint(folderPath: string | null): string | null {
  const name = useVaultName();
  const workspace = useWorkspace();
  if (!name || folderPath === null || underSurfaced(workspace, folderPath)) return null;
  return `New note in ${name}`;
}

/** The note location's accessible name; it names the vault only when note `id` is known to live in it. */
export function useNoteLocationLabel(id: string | null): string {
  const name = useVaultOfNote(id);
  return name ? `Note location in ${name}` : 'Note location';
}
