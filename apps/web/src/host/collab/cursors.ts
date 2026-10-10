import { syncCursorPositions, type BaseBinding, type Binding, type Provider, type SyncCursorPositionsFn, type UserState } from '@lexical/yjs';
import type { LexicalEditor } from 'lexical';
import { createAbsolutePositionFromRelativePosition, createRelativePositionFromJSON } from 'yjs';
import { isRelativePositionJSON } from '@moss-multi/protocol/sync';
import type YProvider from 'y-partyserver/provider';
import { avatarInk } from '../../../../../packages/ui/src/FacePile.tsx';
import { setBatchGeometry } from './landing.ts';
import type { PresenceUser } from './presence.ts';

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

/** The official geometry, coalesced with identity and typing-label decoration. */
export function cursorController(editor: LexicalEditor) {
  let binding: Binding | null = null;
  let provider: Provider | null = null;
  let queued = false;
  let stopped = false;
  const paint = () => {
    if (!binding || !provider || stopped) return;
    syncCursorPositions(binding, provider, options);
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
      selection.name.dataset.cursorLabel = '';
      selection.name.textContent = user.name + (user.isAgent ? ' 🤖' : '');
      selection.name.style.backgroundColor = user.color;
      selection.name.style.color = avatarInk(getComputedStyle(selection.name).backgroundColor);
      selection.name.style.fontFamily = 'inherit';
      selection.name.style.borderRadius = '3px';
      selection.name.style.padding = '3px 5px';
      selection.name.style.display = typeof state?.typingAt === 'number' && Date.now() - state.typingAt < 1500 ? '' : 'none';
      for (const span of selection.selections) {
        span.dataset.remoteSelection = String(id);
        span.dataset.presenceColor = user.color;
        (span.firstChild as HTMLElement).style.backgroundColor = user.color;
      }
    }
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
    queue();
  };
  const start = (source: YProvider) => {
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
    return () => { stopped = true; stopGeometry(); clearInterval(timer); unregister(); awareness.off('update', queue); window.removeEventListener('resize', queue); };
  };
  return { sync, start };
}
