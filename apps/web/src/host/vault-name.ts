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

/** The vault on screen when it lists note `id`; null for a note opened from elsewhere, so a name is never wrong. */
export function useVaultOfNote(id: string | null): string | null {
  const name = useVaultName();
  const workspace = useWorkspace();
  return id && name && workspace?.docs.some((doc) => doc.id === id) ? name : null;
}

/** "+ Note"'s tooltip: where the new note lands. */
export function useNewNoteHint(): string | null {
  const name = useVaultName();
  return name ? `New note in ${name}` : null;
}

/** The note location's accessible name; it names the vault only when the vault on screen lists note `id`. */
export function useNoteLocationLabel(id: string | null): string {
  const name = useVaultOfNote(id);
  return name ? `Note location in ${name}` : 'Note location';
}
