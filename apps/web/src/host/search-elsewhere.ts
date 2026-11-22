// T9.18: choosing a search result from another of the caller's vaults switches to that vault the way the vault
// switcher does, then opens the note. The destination rides on the displayed result itself.
import { getDefaultStore } from 'jotai';
import { activeFolderPathAtom } from '@moss/shared/state/atoms';
import { getBridge, WORKSPACE } from './bridge/index.ts';

/** True when `result` sits in another vault: the switch runs, then `open`. False leaves opening to the caller. */
export function openInResultVault(result: object | undefined, open: () => void): boolean {
  const bridge = getBridge();
  const vault = result && bridge ? bridge[WORKSPACE].resultVault(result) : null;
  if (!bridge || !vault) return false;
  void bridge[WORKSPACE].switchVault(vault)
    .then(() => { getDefaultStore().set(activeFolderPathAtom, 'Notes'); })
    .catch(() => undefined)
    .then(open);
  return true;
}

/** The name of the other vault a displayed result sits in (T9.31), shown on its row; undefined in the vault on screen. */
export function resultVaultName(result: object): string | undefined {
  const bridge = getBridge();
  const vault = bridge ? bridge[WORKSPACE].resultVault(result) : null;
  return vault ? bridge?.[WORKSPACE].getSnapshot()?.vaults?.find((listed) => listed.id === vault)?.name : undefined;
}

/** Where the panel's search is: typed and waiting on the index, answered, or failed (T9.31). */
export type SearchState = 'idle' | 'pending' | 'settled' | 'error';

/** The empty-result caption for each state; settled (and idle) keep Moss's own words. */
export const SEARCH_CAPTION: Partial<Record<SearchState, string>> = {
  pending: 'Searching…',
  error: 'Couldn’t search right now. Try again.',
};
