import { syncCursorPositions, type Binding, type Provider, type SyncCursorPositionsFn } from '@lexical/yjs';
import type { LexicalEditor } from 'lexical';
import type YProvider from 'y-partyserver/provider';
import { avatarInk } from '../../../../../packages/ui/src/FacePile.tsx';
import type { PresenceUser } from './presence.ts';

/** The official geometry, coalesced with identity and typing-label decoration. */
export function cursorController(editor: LexicalEditor) {
  let binding: Binding | null = null;
  let provider: Provider | null = null;
  let queued = false;
  let stopped = false;
  const paint = () => {
    if (!binding || !provider || stopped) return;
    syncCursorPositions(binding, provider);
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
  const queue = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => { queued = false; paint(); });
  };
  const sync: SyncCursorPositionsFn = (next, source) => {
    binding = next as Binding; provider = source;
    // In Suggest and Review the bound doc writes under its own client id; this tab's caret is its awareness id.
    binding.clientID = source.awareness.clientID;
    syncCursorPositions(next, source); queue();
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
    const timer = setInterval(queue, 250);
    window.addEventListener('resize', queue);
    return () => { stopped = true; clearInterval(timer); unregister(); awareness.off('update', queue); window.removeEventListener('resize', queue); };
  };
  return { sync, start };
}
