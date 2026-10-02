// html[data-app-state] (A§19): `booting` from the SSR document until moss's shell renders, then `ready`.
import { APP_STATE_ATTR, type AppState } from '@moss-multi/protocol/dom-contract';

export function setAppState(state: AppState): void {
  document.documentElement.setAttribute(APP_STATE_ATTR, state);
}

/** Resolves `ready` once moss's AppShell is in the document. */
export function readyWhenShellRenders(selector = '[data-moss-app-shell]'): () => void {
  const done = () => {
    if (!document.querySelector(selector)) return false;
    setAppState('ready');
    return true;
  };
  if (done()) return () => undefined;
  const observer = new MutationObserver(() => {
    if (done()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
