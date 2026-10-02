// ported-from: packages/desktop/src/renderer/state/settings-warmup-atoms.ts @ 762abb777
import { atom } from 'jotai';

import { noteIntelligenceEnabledAtom } from '@moss/shared/state/atoms';

import { ensureIsDefaultMdEditorLookupAtom, isDefaultMdEditorAtom } from './default-editor-atoms';
import { refreshGrantedDirsAtom } from './granted-dirs-atoms';
import { ensureWorkspaceInfoAtom, workspaceInfoAtom } from './workspace-info-atoms';

let warmup: Promise<void> | null = null;
let grantedDirsLoaded = false;
let noteIntelligenceLoaded = false;

export const ensureSettingsWarmupAtom = atom(null, (get, set) => {
  if (warmup) return warmup;
  warmup = Promise.all([
    set(ensureWorkspaceInfoAtom),
    set(ensureIsDefaultMdEditorLookupAtom),
    (async () => {
      if (grantedDirsLoaded) return;
      try {
        const dirs = await set(refreshGrantedDirsAtom);
        if (Array.isArray(dirs)) grantedDirsLoaded = true;
      } catch {
        // Leave flag false so a later call can retry.
      }
    })(),
    (async () => {
      if (noteIntelligenceLoaded) return;
      try {
        const enabled = await window.electronAPI?.settings?.getNoteIntelligence();
        if (typeof enabled === 'boolean') {
          set(noteIntelligenceEnabledAtom, enabled);
          noteIntelligenceLoaded = true;
        }
      } catch {
        // Leave flag false so a later call can retry.
      }
    })(),
  ]).then(() => {
    const allLoaded =
      get(workspaceInfoAtom) !== null &&
      get(isDefaultMdEditorAtom) !== null &&
      grantedDirsLoaded &&
      noteIntelligenceLoaded;
    if (!allLoaded) warmup = null;
  });
  return warmup;
});

export const __resetSettingsWarmupForTests = (): void => {
  warmup = null;
  grantedDirsLoaded = false;
  noteIntelligenceLoaded = false;
};
