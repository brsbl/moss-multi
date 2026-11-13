// T3.S6: a large paste lands in batches over several seconds; BodyUndo.hold keeps them one undo step, and releasing
// the hold lets the next edit be its own step again.
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BodyUndo } from './payload-docs.ts';

it('joins every edit made while held to the last step, however late, and lets go when released', () => {
  vi.useFakeTimers();
  try {
    const doc = new Y.Doc();
    const text = doc.getText('t');
    const origin = { name: 'local' };
    // No capture window: Yjs times it with the real clock (lib0 reads Date.now at import), which fake timers leave be.
    const undo = new BodyUndo(new Y.UndoManager(text, { trackedOrigins: new Set([origin]), captureTimeout: 0 }));
    const edit = (at: number, value: string) => doc.transact(() => text.insert(at, value), origin);

    edit(0, 'typed ');
    vi.advanceTimersByTime(5_000);
    undo.stopCapturing();
    edit(6, 'first batch, ');
    for (const batch of ['second batch, ', 'last batch.']) {
      vi.advanceTimersByTime(5_000);
      const release = undo.hold();
      edit(text.length, batch);
      release();
      release();
    }
    vi.advanceTimersByTime(5_000);
    edit(text.length, ' after');
    expect(undo.undoStack).toHaveLength(3);

    undo.undo();
    expect(text.toString()).toBe('typed first batch, second batch, last batch.');
    undo.undo();
    expect(text.toString(), 'one undo removes every batch').toBe('typed ');
    undo.redo();
    expect(text.toString(), 'one redo brings them all back').toBe('typed first batch, second batch, last batch.');
  } finally {
    vi.useRealTimers();
  }
});
