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
