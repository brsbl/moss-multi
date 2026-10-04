// The native menu moss's Edit → "Edit Alt Text…" lives in, on the web (A§9 system; deviation 5): moss reports when
// an image is selected (`setImageAltTextMenuEnabled`) and listens for the command (`onNativeMenuCommand`); the
// image context menu (ImageContextMenu.tsx) reads the one and fires the other.

let enabled = false;
const availability = new Set<() => void>();
const commands = new Set<(command: string) => void>();

export const altTextMenuEnabled = (): boolean => enabled;

export function setAltTextMenuEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  for (const listener of availability) listener();
}

export function subscribeAltTextMenu(listener: () => void): () => void {
  availability.add(listener);
  return () => {
    availability.delete(listener);
  };
}

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
