// Seam (a) of the vendored plugin (A§10.2, A§10.8): the body's undo manager tracks only this client's binding, so
// Cmd+Z never undoes a peer's or the server's writes, and one typing burst is one step.
import type { Binding } from '@lexical/yjs';
import { UndoManager } from 'yjs';

export const REGISTER_LOCAL_ORIGIN = Symbol('moss-multi:register-local');

export const UNDO_CAPTURE_TIMEOUT_MS = 1_000;

export function createBindingUndoManager(binding: Binding): UndoManager {
  return new UndoManager([binding.root.getSharedType(), binding.doc.getMap('registers')], {
    trackedOrigins: new Set([binding, REGISTER_LOCAL_ORIGIN]),
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  });
}
