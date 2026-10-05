// The one owner of programmatic navigation (A§9): sign-in, sign-out, stale-chunk reloads, invites and the bell's
// notices all go through here. `location.assign`, `replace` and `reload` cannot be wrapped (L§4.6), so nothing else in
// host code calls them. A full load after an auth change drops every in-memory moss and bridge cache. The unload
// guard stands aside: sign-out and chunk reload have already waited or asked, and an ended session (4401, A§10.5)
// can never sync what it holds, so asking would not save it.
//
// A notice opens its note in place through moss's own note switch, never a page load, so a sentence typed up to the
// click is kept whole (L§4.6 navigation mid-typing). From the click until the note is live, keys aimed at nothing are
// refused visibly rather than landing on the bell or vanishing.
import { DOC_ID_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR } from '@moss-multi/protocol/dom-contract';
import { allowUnload, waitForAllAcked } from './collab/unacked.ts';
import { armOpeningGuard } from './opening-guard.ts';
import { refuseInput } from './refusal.ts';

/** Replaces this history entry with `href`, so Back never returns to the page that was left. */
export function leaveTo(href: string): void {
  allowUnload();
  window.location.replace(href);
}

export function reloadDocument(): void {
  allowUnload();
  window.location.reload();
}

/** The longest a leave waits for this tab's edits to be acked (A§10.6). */
const ACK_WAIT_MS = 5_000;
export const LEAVE_UNSYNCED = 'Your latest edits haven’t synced yet, so this page stayed open. Try again in a moment.';

/** Leaves for `href` once every edit in the tab is acked; while any is not, the page stays and says why. */
export async function departTo(href: string): Promise<void> {
  const guard = armOpeningGuard('Opening…');
  if (await waitForAllAcked(ACK_WAIT_MS)) {
    leaveTo(href);
    return;
  }
  guard.disarm();
  refuseInput(LEAVE_UNSYNCED);
}

type DocOpener = (docId: string) => void;
let opener: DocOpener | null = null;

/** The bridge hands moss's in-app note switch (its internal-open subscription) to navigation. */
export function registerDocOpener(open: DocOpener): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** The longest keys stay refused while a note opens; past it the pane's own state says what is wrong (T1.3). */
const MAX_OPENING_MS = 30_000;

/** Opens a note in this tab, in place; without moss mounted, it is a page load like any other leave. */
export function openDoc(docId: string): void {
  if (!opener) {
    void departTo(`/d/${encodeURIComponent(docId)}`);
    return;
  }
  const guard = armOpeningGuard();
  const live = `[${EDITOR_PANE_ATTR}][${DOC_ID_ATTR}="${CSS.escape(docId)}"][${DOC_STATE_ATTR}="live"]`;
  const settle = () => {
    observer.disconnect();
    clearTimeout(timer);
    guard.disarm();
  };
  const observer = new MutationObserver(() => {
    if (document.querySelector(live)) settle();
  });
  const timer = setTimeout(settle, MAX_OPENING_MS);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [DOC_STATE_ATTR, DOC_ID_ATTR] });
  opener(docId);
  if (document.querySelector(live)) settle();
}

