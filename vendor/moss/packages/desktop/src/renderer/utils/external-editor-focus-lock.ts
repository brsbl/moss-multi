// ported-from: packages/desktop/src/renderer/utils/external-editor-focus-lock.ts @ 762abb777
let activeLockCount = 0;

export const isExternalEditorFocusLocked = (): boolean => activeLockCount > 0;

export const acquireExternalEditorFocusLock = (): (() => void) => {
  activeLockCount += 1;

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeLockCount = Math.max(0, activeLockCount - 1);
  };
};
