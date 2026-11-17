// The browser's Back and Forward between two notes are moss's to handle (T9.19). The bridge writes those history
// entries past the router, and the router must not hear the popstate either: it would load the route again and
// remount moss's App. Its listener is on window, so this one is installed on window first, before the router exists.
type Listener = () => void;

const listeners = new Set<Listener>();
const NOTE_PATH = /^\/d\/[^/]+\/?$/;

export function installNotePopState(): void {
  window.addEventListener('popstate', (event) => {
    if (!listeners.size || !NOTE_PATH.test(window.location.pathname)) return;
    event.stopImmediatePropagation();
    for (const listener of [...listeners]) listener();
  }, true);
}

/** Called when Back or Forward reaches a note's address while moss is mounted (a listener is registered). */
export function onNotePopState(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
