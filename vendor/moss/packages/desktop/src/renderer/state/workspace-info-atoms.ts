// ported-from: packages/desktop/src/renderer/state/workspace-info-atoms.ts @ 762abb777
import { atom, getDefaultStore } from 'jotai';

import type { GetWorkspacePathResult } from '../../types/electron-api';
import { appConfigApi } from '../api/electron';

export const workspaceInfoAtom = atom<GetWorkspacePathResult | null>(null);

let inflightLookup: Promise<void> | null = null;

export const ensureWorkspaceInfoAtom = atom(null, (get, set) => {
  if (get(workspaceInfoAtom) !== null) return Promise.resolve();
  if (inflightLookup) return inflightLookup;
  inflightLookup = (async () => {
    try {
      const info = await appConfigApi.getWorkspacePath.invoke();
      set(workspaceInfoAtom, info);
    } catch {
      // Leave atom null; a later ensure can retry.
    } finally {
      inflightLookup = null;
    }
  })();
  return inflightLookup;
});

export const refreshWorkspaceInfoAtom = atom(null, async (_get, set) => {
  try {
    const info = await appConfigApi.getWorkspacePath.invoke();
    set(workspaceInfoAtom, info);
  } catch {
    // ignore
  }
});

export const __resetWorkspaceInfoStateForTests = (): void => {
  inflightLookup = null;
  getDefaultStore().set(workspaceInfoAtom, null);
};
