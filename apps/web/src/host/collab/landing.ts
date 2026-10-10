// T3.S6: editors with a large paste still landing in batches. Until the last batch is in, the pane reports unacked
// edits (`data-sync-unacked`), however many of the batches so far the DocDO has acked.
import type { LexicalEditor } from 'lexical';

const landing = new Set<LexicalEditor>();
const listeners = new Set<() => void>();

export function markLanding(editor: LexicalEditor, on: boolean): void {
  if (on === landing.has(editor)) return;
  if (on) landing.add(editor);
  else landing.delete(editor);
  for (const listener of [...listeners]) listener();
}

export const isLanding = (editor: LexicalEditor): boolean => landing.has(editor);

export function subscribeLanding(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
