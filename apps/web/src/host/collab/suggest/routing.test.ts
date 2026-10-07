// @vitest-environment jsdom
// M5 Slop Cop P1 (T5.S1): a strike, then a native join or list-item unwrap at the block's edge, through the real routing
// on a moss editor bound to F. The join re-creates the moved block's text under new ids; the struck characters must
// stay out of the copy, so F, the card, the working export and the accepted text all leave them out, and every
// unstruck character is kept.
import { canonical, yValue } from '@moss-multi/core/suggest/apply';
import { describeHunks } from '@moss-multi/core/suggest/describe';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import {
  $createRangeSelection, $getRoot, $setSelection, COMMAND_PRIORITY_EDITOR, DELETE_CHARACTER_COMMAND, REDO_COMMAND, UNDO_COMMAND, $getSelection, $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { SuggestFork } from '../../../../../../packages/sync/src/suggest/client.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { readRecord, recordIds } from '../../../../../../packages/sync/src/suggest/records.ts';
import {
  acceptRecord, exportWorkingMarkdown, nodeRegistry, previewRecord, rejectRecord, withdrawRecord,
} from '../../../../../../packages/sync/src/suggest/review.ts';
import { deterministicIds, EDITOR, exported, NOTE_ID, seededBody, select, SUGGESTER, textNode } from '../../../../../../packages/sync/src/suggest/test-support.ts';
import { publishBinding } from '../binding-registry.ts';
import { createBindingUndoManager } from '../undo.ts';
import { registerSuggestRouting } from './routing.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

const NOTE = 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.\n';

/** The DocDO's ingest, answering each request the fork sends when `deliver` runs. */
function wire(live: Y.Doc) {
  let n = 0;
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => `r${(n += 1)}` });
  const outbox: SuggestRequest[] = [];
  const replies: SuggestReply[] = [];
  const who = { ...SUGGESTER, role: 'suggester', connection: 'routing' };
  return {
    replies,
    send: (request: SuggestRequest) => outbox.push(request),
    deliver(fork: SuggestFork) {
      while (outbox.length) {
        const reply = handleSuggest(ingest, who, outbox.shift()!);
        replies.push(reply);
        fork.receive(reply);
      }
    },
  };
}

/** A suggester's pane: a moss editor bound to F, with the routing, the body's undo stack and a native Backspace. */
function suggesting(markdown: string) {
  const live = seededBody(markdown);
  const link = wire(live);
  const fork = new SuggestFork(live, { me: SUGGESTER.id, name: SUGGESTER.name, send: link.send, now: () => 1_000 });
  const bound = bindEditor(fork.doc);
  const editor: LexicalEditor = bound.editor;
  const undo = createBindingUndoManager(bound.binding);
  (editor as unknown as Record<symbol, unknown>)[Symbol.for('@lexical/yjs/UndoManager')] = undo;
  const stops = [
    publishBinding(editor, bound.binding),
    // As moss's rich text and the collaboration plugin handle them, below the routing.
    editor.registerCommand(DELETE_CHARACTER_COMMAND, (backward) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.deleteCharacter(backward);
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    editor.registerCommand(UNDO_COMMAND, () => {
      undo.undo();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    editor.registerCommand(REDO_COMMAND, () => {
      undo.redo();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    registerSuggestRouting(editor, fork),
  ];
  fork.begin();
  link.deliver(fork);
  editor.update(() => {}, { discrete: true });
  const run = (step: () => void) => {
    editor.update(step, { discrete: true });
    editor.update(() => {}, { discrete: true });
    link.deliver(fork);
  };
  return {
    live,
    fork,
    replies: link.replies,
    /** Puts the caret (or a selection) in the text node starting with `prefix`. */
    caret: (prefix: string, anchor: number, focus = anchor) => run(() => {
      select(prefix, anchor, focus);
    }),
    /** A selection from `offset` in the text node starting with `from` to `focus` in the one starting with `to`. */
    across: (from: string, offset: number, to: string, focus: number) => run(() => {
      const selection = $createRangeSelection();
      selection.anchor.set(textNode(from).getKey(), offset, 'text');
      selection.focus.set(textNode(to).getKey(), focus, 'text');
      $setSelection(selection);
    }),
    press: (key: 'Backspace' | 'Delete') => run(() => {
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, key === 'Backspace');
    }),
    undo: () => run(() => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    }),
    redo: () => run(() => {
      editor.dispatchCommand(REDO_COMMAND, undefined);
    }),
    /** What the suggester sees in F. */
    text: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
    dispose: () => {
      for (const stop of stops) stop();
      undo.destroy();
      bound.dispose();
      fork.dispose();
    },
  };
}

type Pane = ReturnType<typeof suggesting>;

/** The one record, its card's inserted and deleted texts, the working export, and the text accept lands. */
function reviewed(pane: Pane) {
  expect(pane.replies.filter((reply) => reply.t === 'suggest-refused'), 'never refused').toEqual([]);
  const ids = recordIds(pane.live);
  expect(ids, 'one suggestion').toHaveLength(1);
  const [id] = ids;
  const record = readRecord(pane.live, id)!;
  const preview = previewRecord(pane.live, id);
  expect(preview, 'previewed').toMatchObject({ ok: true });
  if (!preview.ok) throw new Error('no preview');
  const rows = describeHunks(preview.hunks);
  const working = exportWorkingMarkdown(pane.live, NOTE_ID);
  const accepted = acceptRecord(pane.live, id, { previewHash: preview.hash, digest: preview.digest }, EDITOR);
  expect(accepted, 'accepted').toEqual({ ok: true });
  return {
    record,
    inserted: rows.filter((row) => row.kind === 'insert').map((row) => row.text),
    deleted: rows.filter((row) => row.kind === 'delete').map((row) => row.text),
    working,
    body: exported(pane.live),
  };
}

describe('a strike, then a native join or unwrap at the block edge, keeps the strike @p:mean-2 @p:R17', () => {
  it("strike 'a', then Backspace at the block's start: F, the card, the working view and accept all leave 'a' out", () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      expect(pane.fork.struck(), 'the strike').toHaveLength(1);
      pane.press('Backspace');
      expect(pane.text(), 'F: joined, without the struck character').toBe('Intro line stays.bc tail.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { record, inserted, deleted, working, body } = reviewed(pane);
    expect(record.parts, 'the strike stays a part').toHaveLength(1);
    expect(inserted.join(''), 'the card adds the moved text without it').toBe('bc tail.');
    expect(deleted.join(' '), 'the card removes the old block').toContain('abc tail.');
    expect(working).toContain('Intro line stays.bc tail.');
    expect(working).not.toContain('abc');
    expect(body).toContain('Intro line stays.bc tail.');
    expect(body, 'the struck character is gone').not.toContain('abc');
    expect(body, 'unstruck text is kept').toContain('Closing line stays too.');
  });

  it('several struck characters, then Backspace at the start: each stays out', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.caret('abc', 3);
      pane.press('Backspace');
      pane.caret('abc', 7);
      pane.press('Backspace');
      expect(pane.fork.struck(), 'three strikes').toHaveLength(3);
      pane.caret('abc', 0);
      pane.press('Backspace');
      expect(pane.text()).toBe('Intro line stays.b tal.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join('')).toBe('b tal.');
    expect(working).toContain('Intro line stays.b tal.');
    expect(body).toContain('Intro line stays.b tal.');
    expect(body).toContain('Closing line stays too.');
  });

  it('a struck run across the join point: the end of the block before stays struck, the start of the moved block stays out', () => {
    const pane = suggesting(NOTE);
    try {
      // "s." at the end of the first block through "a" at the start of the second, in one strike.
      pane.across('Intro', 'Intro line stays.'.length - 2, 'abc', 1);
      pane.press('Backspace');
      expect(pane.fork.struck().reduce((sum, span) => sum + span.len, 0), 'one strike over three characters').toBe(3);
      pane.press('Backspace');
      expect(pane.text(), "the block before keeps its struck characters, painted; the moved block drops its own").toBe('Intro line stays.bc tail.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join('')).toBe('bc tail.');
    expect(working).toContain('Intro line staybc tail.');
    expect(body).toContain('Intro line staybc tail.');
    expect(body).not.toContain('abc');
  });

  it('Delete at the end of the block before pulls the next block in without its struck characters', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.caret('Intro', 'Intro line stays.'.length);
      pane.press('Delete');
      expect(pane.text()).toBe('Intro line stays.bc tail.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { body } = reviewed(pane);
    expect(body).toContain('Intro line stays.bc tail.');
    expect(body).not.toContain('abc');
  });

  it('a whole list item struck, then Backspace once more: the unwrapped item leaves its text out, and its neighbours stay', () => {
    const pane = suggesting('- alpha item\n- beta item\n- gamma item\n');
    try {
      pane.caret('beta', 0, 'beta item'.length);
      pane.press('Backspace');
      pane.press('Backspace');
      expect(pane.text()).not.toContain('beta');
      expect(pane.text()).toContain('alpha item');
      expect(pane.text()).toContain('gamma item');
    } finally {
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join(' '), 'the card adds no struck text').not.toContain('beta');
    expect(working).not.toContain('beta');
    expect(body, 'accept removes the struck item text').not.toContain('beta');
    expect(body).toContain('alpha item');
    expect(body).toContain('gamma item');
  });

  it('undo of the join splits the block again without the struck character, and redo joins it again', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.caret('abc', 0);
      pane.press('Backspace');
      pane.undo();
      expect(pane.text(), 'undo takes the join back; the strike stands').toBe('Intro line stays.\n\nbc tail.\n\nClosing line stays too.');
      pane.redo();
      expect(pane.text(), 'redo joins again').toBe('Intro line stays.bc tail.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { body } = reviewed(pane);
    expect(body).toContain('Intro line stays.bc tail.');
    expect(body).not.toContain('abc');
  });

  it('undo of the join, then accept: the split block is accepted without the struck character', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.caret('abc', 0);
      pane.press('Backspace');
      pane.undo();
    } finally {
      pane.dispose();
    }
    const { working, body } = reviewed(pane);
    expect(working).toContain('Intro line stays.\n\nbc tail.');
    expect(body).toContain('Intro line stays.\n\nbc tail.');
    expect(body).not.toContain('abc');
  });

  it('undo of the join and then of the strike brings the struck character back: F, the working view and accept match the note', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.caret('abc', 0);
      pane.press('Backspace');
      pane.undo();
      expect(pane.text(), 'the join taken back, the strike stands').toBe('Intro line stays.\n\nbc tail.\n\nClosing line stays too.');
      pane.undo();
      expect(pane.text(), 'the strike taken back: "a" is live again').toBe('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
      expect(pane.fork.struck(), 'nothing struck').toEqual([]);
    } finally {
      pane.dispose();
    }
    const { record, working, body } = reviewed(pane);
    expect(record.parts, 'no part left').toEqual([]);
    expect(working).toContain('Intro line stays.\n\nabc tail.');
    expect(body, 'accept lands the original text').toBe(exported(seededBody(NOTE)));
  });

  it('undo of the join and the strike, then redo of both: the struck character stays out again', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.caret('abc', 0);
      pane.press('Backspace');
      pane.undo();
      pane.undo();
      expect(pane.text()).toBe('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
      pane.redo();
      expect(pane.text(), 'the strike again').toBe('Intro line stays.\n\nbc tail.\n\nClosing line stays too.');
      pane.redo();
      expect(pane.text(), 'the join again').toBe('Intro line stays.bc tail.\n\nClosing line stays too.');
      pane.undo();
      pane.undo();
      expect(pane.text(), 'and back once more').toBe('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
      pane.redo();
      pane.redo();
    } finally {
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join('')).toBe('bc tail.');
    expect(working).toContain('Intro line stays.bc tail.');
    expect(body).toContain('Intro line stays.bc tail.');
    expect(body).not.toContain('abc');
    expect(body).toContain('Closing line stays too.');
  });

  it('several strikes, a join, then undo of everything: every struck character comes back in place', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.caret('abc', 3);
      pane.press('Backspace');
      pane.caret('abc', 7);
      pane.press('Backspace');
      pane.caret('abc', 0);
      pane.press('Backspace');
      expect(pane.text()).toBe('Intro line stays.b tal.\n\nClosing line stays too.');
      pane.undo();
      pane.undo();
      expect(pane.text(), 'the last strike back').toBe('Intro line stays.\n\nb tail.\n\nClosing line stays too.');
      pane.undo();
      pane.undo();
      expect(pane.text(), 'all back').toBe('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { body } = reviewed(pane);
    expect(body).toBe(exported(seededBody(NOTE)));
  });

  it('reject and withdraw of a strike-then-join leave the body byte-identical', () => {
    for (const close of ['reject', 'withdraw'] as const) {
      const pane = suggesting(NOTE);
      const root = (doc: Y.Doc) => canonical(yValue(doc.get('root', Y.XmlText)));
      const before = root(pane.live);
      const body = exported(pane.live);
      try {
        pane.caret('abc', 1);
        pane.press('Backspace');
        pane.press('Backspace');
      } finally {
        pane.dispose();
      }
      const [id] = recordIds(pane.live);
      const result = close === 'reject' ? rejectRecord(pane.live, id, EDITOR) : withdrawRecord(pane.live, id, { ...SUGGESTER, role: 'suggester' });
      expect(result, close).toEqual({ ok: true });
      expect(exported(pane.live), `${close}: the note is unchanged`).toBe(body);
      expect(root(pane.live), `${close}: the body is unchanged`).toBe(before);
    }
  });
});
