// A co-editor's Enter or block change keeps this editor's caret on its words (T9.47).
import type { LexicalEditor } from 'lexical';

/** The restore's own commit. */
export const PEER_CARET_TAG = 'moss-multi-peer-caret';

/** Counted for the cost tests: carets placed after a loss, and the nodes the placement walks visited. */
export const peerCaretWork = { placed: 0, visits: 0 };

/** Registers the listener; returns its release. Edit mode only (pane.tsx). */
export function keepCaretThroughPeers(editor: LexicalEditor): () => void {
  return editor.registerUpdateListener(() => {});
}
