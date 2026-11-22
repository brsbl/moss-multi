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

/** The nearest ancestor that clips horizontally (the names' gutters end at its edges), found once per editor root. */
const clips = new WeakMap<HTMLElement, HTMLElement>();
function clipOf(root: HTMLElement): HTMLElement {
  let clip = clips.get(root);
  if (clip?.isConnected && clip.contains(root)) return clip;
  clip = document.documentElement;
  for (let at = root.parentElement; at; at = at.parentElement) {
    if (getComputedStyle(at).overflowX !== 'visible') { clip = at; break; }
  }
  clips.set(root, clip);
  return clip;
}

/**
 * The text column of the caret's line: the top-level block the caret's middle falls in, else the whole body. Blocks
 * stack top to bottom, so it is found in a few reads however long the note is. A collapsed section's blocks stay in
 * the root with no box (display:none), so a probe that lands on one moves to the next block that has a box.
 */
export function columnAt(root: HTMLElement, y: number): { left: number; right: number } {
  const blocks = root.children;
  for (let low = 0, high = blocks.length - 1; low <= high;) {
    const middle = (low + high) >> 1;
    let at = middle;
    let box = blocks[at]!.getBoundingClientRect();
    while (box.height === 0 && at < high) box = blocks[++at]!.getBoundingClientRect();
    if (box.height === 0 || y < box.top) high = middle - 1;
    else if (y > box.bottom) low = at + 1;
    else return { left: box.left, right: box.right };
  }
  const box = root.getBoundingClientRect();
  return { left: box.left, right: box.right };
}

/** Sets one inline style only when it changes, so a steady repaint dirties nothing. */
function setStyle(element: HTMLElement, property: 'display' | 'visibility' | 'left' | 'top', value: string): void {
  if (element.style[property] !== value) element.style[property] = value;
}

interface Shown { id: number; caret: HTMLElement; name: HTMLElement; typing: boolean }
/** Each name's size, measured when its text changes (a name's size does not depend on where it sits). */
let sizes = new WeakMap<HTMLElement, { text: string; width: number; height: number }>();

/** The official geometry, coalesced with identity and typing-label decoration. */
export function cursorController(editor: LexicalEditor) {
  let binding: Binding | null = null;
  let provider: Provider | null = null;
  let docId: string | null = null;
  let queued = false;
  let stopped = false;
  /**
   * Puts each shown name in a gutter beside its line; a typing name with no room is left to People here. All layout
   * reads come first and every write after them, so a repaint lays the page out at most once more than the cursor
   * pass itself does: in a long note, each extra layout held the tab during a paste (run 44262371127).
   */
  const placeNames = (shown: Shown[]) => {
    const root = editor.getRootElement();
    if (!shown.length || !root) { if (docId) setUnplacedTyping(docId, []); return; }
    const unmeasured = shown.filter(({ name }) => sizes.get(name)?.text !== name.dataset.labelText);
    for (const { name } of unmeasured) { setStyle(name, 'visibility', 'hidden'); setStyle(name, 'display', ''); }
    for (const { name } of unmeasured) {
      const box = name.getBoundingClientRect();
      sizes.set(name, { text: name.dataset.labelText ?? '', width: box.width, height: box.height });
    }
    const carets = new Map<number, DOMRect>();
    const requests: LabelRequest[] = shown.map(({ id, caret, name }) => {
      const caretBox = caret.getBoundingClientRect();
      carets.set(id, caretBox);
      const { width, height } = sizes.get(name)!;
      return {
        id, caretX: caretBox.left, caretTop: caretBox.top, caretHeight: caretBox.height, width, height,
        column: columnAt(root, caretBox.top + caretBox.height / 2),
      };
    });
    const clip = clipOf(root).getBoundingClientRect();
    const { placed, unplaced } = placeLabels(requests, { left: clip.left, right: clip.right });
    for (const { id, name } of shown) {
      const at = placed.get(id);
      if (!at) { setStyle(name, 'display', 'none'); continue; }
      const caretBox = carets.get(id)!;
      setStyle(name, 'left', `${at.x - caretBox.left}px`);
      setStyle(name, 'top', `${at.y - caretBox.top}px`);
      setStyle(name, 'display', '');
      setStyle(name, 'visibility', '');
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
      const width = watched === id ? '2px' : '1px';
      if (selection.caret.style.width !== width) selection.caret.style.width = width;
      const label = peers.find((peer) => peer.clientId === id)?.label ?? user.name;
      dress(selection.name, user.color, label + (user.isAgent ? ' · Bot' : ''));
      const typing = typeof state?.typingAt === 'number' && Date.now() - state.typingAt < TYPING_LABEL_MS;
      if (typing || watched === id) shown.push({ id, caret: selection.caret, name: selection.name, typing });
      else setStyle(selection.name, 'display', 'none');
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
    const resized = () => { sizes = new WeakMap(); queue(); };
    window.addEventListener('resize', resized);
    // A web font that arrives after a name was measured changes its size.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', resized);
    return () => { if (docId) setUnplacedTyping(docId, []); stopped = true; stopGeometry(); clearInterval(timer); unregister(); awareness.off('update', queue); window.removeEventListener('resize', resized); fonts?.removeEventListener?.('loadingdone', resized); };
  };
  return { sync, start };
}
