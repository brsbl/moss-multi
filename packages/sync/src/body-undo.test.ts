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

// T9.14: each step keeps where the caret was before it and after its last edit; undo restores the first, redo the
// second, through every round.
it('restores the caret from before a step on undo and from after it on redo', () => {
  const doc = new Y.Doc();
  const text = doc.getText('t');
  const origin = { name: 'local' };
  // Edits join a step until stopCapturing ends it.
  const undo = new BodyUndo(new Y.UndoManager(text, { trackedOrigins: new Set([origin]), captureTimeout: 60_000 }));
  // `prior` is the caret as the editor's update began, `caret` the caret now.
  let prior = 'start';
  let caret = 'start';
  const restored: unknown[] = [];
  undo.carets = { before: () => prior, after: () => caret, restore: (at) => { restored.push(at); } };
  try {
    prior = 'before one';
    doc.transact(() => { text.insert(0, 'one'); caret = 'after one'; }, origin);
    undo.stopCapturing();
    prior = 'before two';
    doc.transact(() => { text.insert(3, ' two'); caret = 'inside two'; }, origin);
    prior = 'inside two';
    doc.transact(() => { text.insert(7, '!'); caret = 'after two'; }, origin);
    expect(undo.undoStack).toHaveLength(2);
    prior = caret = 'moved away';
    undo.undo();
    undo.undo();
    expect(text.toString()).toBe('');
    undo.redo();
    undo.redo();
    expect(text.toString()).toBe('one two!');
    undo.undo();
    undo.redo();
    expect(restored).toEqual(['before two', 'before one', 'after one', 'after two', 'before two', 'after two']);
  } finally {
    undo.destroy();
    doc.destroy();
  }
});
