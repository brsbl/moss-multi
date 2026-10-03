// Seam (a) of the vendored plugin (A§10.2, A§10.8): the body's undo manager tracks only this client's binding, so
// Cmd+Z never undoes a peer's or the server's writes, and one typing burst is one step.
import type { Binding } from '@lexical/yjs';
import { UndoManager } from 'yjs';

export const UNDO_CAPTURE_TIMEOUT_MS = 1_000;

export function createBindingUndoManager(binding: Binding): UndoManager {
  return new UndoManager(binding.root.getSharedType(), {
    trackedOrigins: new Set([binding]),
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  });
}
