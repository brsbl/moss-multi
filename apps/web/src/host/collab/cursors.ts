import { syncCursorPositions, type BaseBinding, type Binding, type Provider, type SyncCursorPositionsFn, type UserState } from '@lexical/yjs';
import type { LexicalEditor } from 'lexical';
import { createAbsolutePositionFromRelativePosition, createRelativePositionFromJSON } from 'yjs';
import { isRelativePositionJSON } from '@moss-multi/protocol/sync';
import type YProvider from 'y-partyserver/provider';
import { placeLabels, type LabelRequest } from './label-place.ts';
import { setBatchGeometry } from './landing.ts';
import { inspectedOf, peersOf, setUnplacedTyping, type PresenceUser } from './presence.ts';

/**
 * Peers whose positions Yjs can resolve, normalized to RelativePositions; a malformed or unresolvable peer is
 * skipped alone, so the pass still paints everyone else and removes departed cursors.
 */
export function paintableStates(binding: BaseBinding, provider: Provider): Map<number, UserState> {
  const states = new Map<number, UserState>();
  for (const [id, state] of provider.awareness.getStates()) {
    try {
      if (!isRelativePositionJSON(state.anchorPos) || !isRelativePositionJSON(state.focusPos)) continue;
      const anchorPos = state.anchorPos ? createRelativePositionFromJSON(state.anchorPos) : null;
      const focusPos = state.focusPos ? createRelativePositionFromJSON(state.focusPos) : null;
      for (const position of [anchorPos, focusPos]) if (position) createAbsolutePositionFromRelativePosition(position, binding.doc);
      states.set(id, { ...state, anchorPos, focusPos });
    } catch { /* This peer's cursor is not painted. */ }
  }
  return states;
}
const options = { getAwarenessStates: paintableStates };

/** How long a remote name shows after that person's last keystroke. */
export const TYPING_LABEL_MS = 1500;
/** A remote name is Moss's tooltip material (its TooltipContent), never a tag filled with the peer's colour (T9.32). */
const LABEL_CLASS = 'pointer-events-none absolute z-tooltip whitespace-nowrap rounded-md border border-border-subtle bg-surface-floating px-2.5 py-1 text-nano font-light text-ink-default shadow-md';
const SWATCH_CLASS = 'mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle';

/** Dresses Lexical's name element once per change of text or colour: neutral material, a swatch of the caret colour. */
function dress(name: HTMLElement, color: string, text: string): void {
  if (name.dataset.cursorLabel === undefined) {
    name.removeAttribute('style');
    name.className = LABEL_CLASS;
    name.dataset.cursorLabel = '';
  }
  if (name.dataset.labelText === text && name.dataset.presenceColor === color) return;
  const swatch = document.createElement('span');
  swatch.className = SWATCH_CLASS;
  swatch.dataset.presenceSwatch = '';
  swatch.dataset.presenceColor = color;
  swatch.style.backgroundColor = color;
  name.replaceChildren(swatch, document.createTextNode(text));
  name.dataset.labelText = text;
  name.dataset.presenceColor = color;
}

/** The nearest ancestor that clips horizontally: the names' gutters end at its edges. */
function clipOf(element: HTMLElement): DOMRect {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (getComputedStyle(at).overflowX !== 'visible') return at.getBoundingClientRect();
  }
  return document.documentElement.getBoundingClientRect();
}

/** The text column of the caret's line: the top-level block the caret's middle falls in, else the whole body. */
function columnAt(root: HTMLElement, y: number): { left: number; right: number } {
  for (const block of root.children) {
    const box = block.getBoundingClientRect();
    if (box.height > 0 && box.top <= y && y <= box.bottom) return { left: box.left, right: box.right };
  }
  const box = root.getBoundingClientRect();
  return { left: box.left, right: box.right };
}

interface Shown { id: number; caret: HTMLElement; name: HTMLElement; typing: boolean }

/** The official geometry, coalesced with identity and typing-label decoration. */
export function cursorController(editor: LexicalEditor) {
  let binding: Binding | null = null;
  let provider: Provider | null = null;
  let docId: string | null = null;
  let queued = false;
  let stopped = false;
  /** Puts each shown name in a gutter beside its line; a typing name with no room is left to People here. */
  const placeNames = (shown: Shown[]) => {
    const root = editor.getRootElement();
    if (!shown.length || !root) { if (docId) setUnplacedTyping(docId, []); return; }
    const requests: LabelRequest[] = [];
    for (const { id, caret, name } of shown) {
      name.style.display = '';
      name.style.visibility = 'hidden';
      name.style.left = '0px';
      name.style.top = '0px';
      const caretBox = caret.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      requests.push({
        id, caretX: caretBox.left, caretTop: caretBox.top, caretHeight: caretBox.height, width: nameBox.width, height: nameBox.height,
        column: columnAt(root, caretBox.top + caretBox.height / 2),
      });
    }
    const clip = clipOf(root);
    const { placed, unplaced } = placeLabels(requests, { left: clip.left, right: clip.right });
    for (const { id, caret, name } of shown) {
      const at = placed.get(id);
      if (!at) { name.style.display = 'none'; continue; }
      const caretBox = caret.getBoundingClientRect();
      name.style.left = `${at.x - caretBox.left}px`;
      name.style.top = `${at.y - caretBox.top}px`;
      name.style.visibility = '';
    }
    const typing = new Set(shown.filter((entry) => entry.typing).map((entry) => entry.id));
    if (docId) setUnplacedTyping(docId, unplaced.filter((id) => typing.has(id)).sort((a, b) => a - b));
  };
  const paint = () => {
    if (!binding || !provider || stopped) return;
    syncCursorPositions(binding, provider, options);
    const peers = docId ? peersOf(docId) : [];
    const watched = docId ? inspectedOf(docId) : null;
    const shown: Shown[] = [];
    for (const [id, cursor] of binding.cursors) {
      const state = provider.awareness.getStates().get(id) as { user?: PresenceUser; typingAt?: number } | undefined;
      const user = state?.user as PresenceUser | undefined;
      const selection = cursor.selection;
      if (!selection || !user) continue;
      cursor.color = user.color;
      selection.color = user.color;
      selection.caret.dataset.remoteCaret = String(id);
      selection.caret.dataset.presenceColor = user.color;
      selection.caret.style.backgroundColor = user.color;
      // The person inspected in the roster has a heavier caret, in place: nothing scrolls and the local caret stays.
      selection.caret.style.width = watched === id ? '2px' : '1px';
      const label = peers.find((peer) => peer.clientId === id)?.label ?? user.name;
      dress(selection.name, user.color, label + (user.isAgent ? ' · Bot' : ''));
      const typing = typeof state?.typingAt === 'number' && Date.now() - state.typingAt < TYPING_LABEL_MS;
      if (typing || watched === id) shown.push({ id, caret: selection.caret, name: selection.name, typing });
      else selection.name.style.display = 'none';
      for (const span of selection.selections) {
        span.dataset.remoteSelection = String(id);
        span.dataset.presenceColor = user.color;
        (span.firstChild as HTMLElement).style.backgroundColor = user.color;
      }
    }
    placeNames(shown);
  };
  // Cursor geometry reads layout, so it runs once the task that changed awareness is done, once for any number of
  // changes, or in a large paste's batch right after the batch's own layout (setBatchGeometry). Inside the editor
  // update (each batch changes the selection and the typing clock) it laid the whole note out per change.
  const flush = () => {
    if (!queued) return;
    queued = false;
    paint();
  };
  const queue = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(flush);
  };
  const sync: SyncCursorPositionsFn = (next, source) => {
    binding = next as Binding; provider = source;
    // In Suggest and Review the bound doc writes under its own client id; this tab's caret is its awareness id.
    binding.clientID = (source.awareness as unknown as { clientID: number }).clientID;
    queue();
  };
  const start = (source: YProvider, doc: string | null = null) => {
    docId = doc;
    stopped = false;
    const awareness = source.awareness;
    awareness.on('update', queue);
    const unregister = editor.registerUpdateListener(({ tags, dirtyElements, dirtyLeaves }) => {
      if (!tags.has('collaboration') && (dirtyElements.size || dirtyLeaves.size)) {
        const state = awareness.getLocalState();
        if (state) awareness.setLocalState({ ...state, typingAt: Date.now() });
      }
      queue();
    });
    const stopGeometry = setBatchGeometry(editor, flush);
    const timer = setInterval(queue, 250);
    window.addEventListener('resize', queue);
    return () => { if (docId) setUnplacedTyping(docId, []); stopped = true; stopGeometry(); clearInterval(timer); unregister(); awareness.off('update', queue); window.removeEventListener('resize', queue); };
  };
  return { sync, start };
}
