// Seam (b) of the vendored plugin (A§10.2): a Lexical update carrying moss's derived tags (formula refresh, localized
// images) reaches Yjs under DERIVED_ORIGIN, so it is neither undoable nor folded back into the editor that made it.
import type { Binding } from '@lexical/yjs';
import { DIRTY_TRACKER_DERIVED_TAGS } from '@moss-desktop/renderer/editor/utils/editorUpdateTags';

export const DERIVED_ORIGIN = Symbol('moss-multi:derived');

/** Origins the Yjs-to-Lexical path skips: this binding's own writes, plain or derived. */
export const isOwnOrigin = (origin: unknown, binding: Binding): boolean => origin === binding || origin === DERIVED_ORIGIN;

/** Runs the binding's Lexical-to-Yjs sync, inside a DERIVED_ORIGIN transaction when the update is derived. */
export function syncUnderOrigin(binding: Binding, tags: Set<string>, sync: () => void): void {
  for (const tag of DIRTY_TRACKER_DERIVED_TAGS) {
    if (tags.has(tag)) {
      binding.doc.transact(sync, DERIVED_ORIGIN);
      return;
    }
  }
  sync();
}
