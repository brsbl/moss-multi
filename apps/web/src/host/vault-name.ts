// The vault's name where a signed-in person works (T9.31): the tab, the note's location and "+ Note" name it, so the
// vault on screen is known without a header control. A link visitor is shown no vault name.
import { useSyncExternalStore } from 'react';
import { useAuthState } from './auth.ts';
import { getBridge, WORKSPACE } from './bridge/index.ts';

const noSubscribe = () => () => {};
const noSnapshot = () => null;

function useWorkspace() {
  const bridge = getBridge() ?? null;
  return useSyncExternalStore(bridge?.[WORKSPACE].subscribe ?? noSubscribe, bridge?.[WORKSPACE].getSnapshot ?? noSnapshot, noSnapshot);
}

/** The vault on screen, for a signed-in person; null for a link visitor. */
export function useVaultName(): string | null {
  const auth = useAuthState();
  const workspace = useWorkspace();
  return auth.status === 'signed-in' ? workspace?.vault.name ?? null : null;
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

/** The note location's accessible name. */
export function useNoteLocationLabel(): string {
  const name = useVaultName();
  return name ? `Note location in ${name}` : 'Note location';
}
