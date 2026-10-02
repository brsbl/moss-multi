// ported-from: packages/desktop/src/renderer/state/default-editor-atoms.ts @ 762abb777
import { atom, getDefaultStore } from 'jotai';

export const isDefaultMdEditorAtom = atom<boolean | null>(null);

let inflightLookup: Promise<void> | null = null;
let writeGeneration = 0;

export const ensureIsDefaultMdEditorLookupAtom = atom(null, (get, set) => {
  if (get(isDefaultMdEditorAtom) !== null) return Promise.resolve();
  if (inflightLookup) return inflightLookup;

  const startedAt = writeGeneration;
  inflightLookup = (async () => {
    try {
      const isDefault = await window.electronAPI?.settings?.isDefaultMdEditor();
      // A refresh or optimistic write happened during the IPC — newer truth wins.
      if (writeGeneration !== startedAt) return;
      if (typeof isDefault === 'boolean') {
        set(isDefaultMdEditorAtom, isDefault);
      }
    } catch {
      // Leave atom null so a later open can retry.
    } finally {
      inflightLookup = null;
    }
  })();
  return inflightLookup;
});

export const refreshIsDefaultMdEditorAtom = atom(null, async (_get, set) => {
  writeGeneration += 1;
  try {
    const isDefault = await window.electronAPI?.settings?.isDefaultMdEditor();
    if (typeof isDefault === 'boolean') {
      set(isDefaultMdEditorAtom, isDefault);
    }
  } catch {
    // ignore
  }
});

export const setIsDefaultMdEditorAtom = atom(null, (_get, set, value: boolean) => {
  writeGeneration += 1;
  set(isDefaultMdEditorAtom, value);
});

export const __resetDefaultMdEditorStateForTests = (): void => {
  inflightLookup = null;
  writeGeneration = 0;
  getDefaultStore().set(isDefaultMdEditorAtom, null);
};
