// moss's native-menu command channel on the web (A§9 system; deviation 5): moss listens through
// `onNativeMenuCommand`, and the image context menu (ImageContextMenu.tsx) fires "edit-image-alt-text" into it.

const commands = new Set<(command: string) => void>();

/** moss's `system.onNativeMenuCommand`. */
export function onNativeMenuCommand(callback: (command: string) => void): () => void {
  commands.add(callback);
  return () => {
    commands.delete(callback);
  };
}

export function runNativeMenuCommand(command: string): void {
  for (const callback of [...commands]) callback(command);
}
