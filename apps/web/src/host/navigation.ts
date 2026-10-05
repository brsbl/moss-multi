// The one owner of programmatic navigation (A§9): sign-in, sign-out, stale-chunk reloads, invites and the bell's
// notices all go through here. `location.assign`, `replace` and `reload` cannot be wrapped (L§4.6), so nothing else in
// host code calls them. A full load after an auth change drops every in-memory moss and bridge cache. The unload
// guard stands aside: sign-out and chunk reload have already waited or asked, and an ended session (4401, A§10.5)
// can never sync what it holds, so asking would not save it.
//
// A notice opens its note in place through moss's own note switch, never a page load, so a sentence typed up to the
// click is kept whole (L§4.6 navigation mid-typing). From the click until the note is live, keys aimed at nothing are
// refused visibly rather than landing on the bell or vanishing.
import { BODY_BINDING_ATTR, DOC_ID_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR } from '@moss-multi/protocol/dom-contract';
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

/** Opens a note in this tab, in place; without moss mounted, it is a page load like any other leave. Once its body
 * is bound, a live body takes focus, so keys typed straight on through the switch land in the note that opened. */
export function openDoc(docId: string): void {
  if (!opener) {
    void departTo(`/d/${encodeURIComponent(docId)}`);
    return;
  }
  const guard = armOpeningGuard();
  const pane = `[${EDITOR_PANE_ATTR}][${DOC_ID_ATTR}="${CSS.escape(docId)}"][${DOC_STATE_ATTR}="live"]`;
  const bound = `${pane} [${BODY_BINDING_ATTR}="live"], ${pane} [${BODY_BINDING_ATTR}="readonly"]`;
  const settle = (body: HTMLElement | null) => {
    observer.disconnect();
    clearTimeout(timer);
    const active = document.activeElement;
    const typingElsewhere = active instanceof HTMLElement && active !== document.body && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (body?.getAttribute(BODY_BINDING_ATTR) === 'live' && !typingElsewhere) {
      body.focus({ preventScroll: true });
      // The caret goes to the end of the note, where typing straight on continues.
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    }
    guard.disarm();
  };
  const check = () => {
    const body = document.querySelector<HTMLElement>(bound);
    if (body) settle(body);
  };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => settle(null), MAX_OPENING_MS);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [DOC_STATE_ATTR, DOC_ID_ATTR, BODY_BINDING_ATTR] });
  opener(docId);
  check();
}
