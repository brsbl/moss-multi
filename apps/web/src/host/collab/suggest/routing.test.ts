// @vitest-environment jsdom
// M5 Slop Cop P1 (T5.S1): a strike, then a native join or list-item unwrap at the block's edge, through the real routing
// on a moss editor bound to F. The join re-creates the moved block's text under new ids; the struck characters must
// stay out of the copy, so F, the card, the working export and the accepted text all leave them out, and every
// unstruck character is kept.
import { $insertGeneratedNodes } from '@lexical/clipboard';
import { $generateNodesFromDOM } from '@lexical/html';
import { canonical, yValue } from '@moss-multi/core/suggest/apply';
import { describeHunks } from '@moss-multi/core/suggest/describe';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { IdSpan, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import {
  $createRangeSelection, $getNodeByKey, $getRoot, $setSelection, createEditor, type RangeSelection, COMMAND_PRIORITY_EDITOR, COMMAND_PRIORITY_HIGH, DELETE_CHARACTER_COMMAND, REDO_COMMAND, UNDO_COMMAND, $getSelection, $isRangeSelection,
  $createTextNode, $isElementNode, $isParagraphNode, $isTextNode, $parseSerializedNode, TextNode, type LexicalEditor, type LexicalNode,
  type SerializedLexicalNode,
} from 'lexical';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { MARKDOWN_EDITOR_NODES } from '../../../../../../packages/sync/src/converter/index.ts';
import { Composite, destroyView, SuggestFork } from '../../../../../../packages/sync/src/suggest/client.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { readRecord, recordIds } from '../../../../../../packages/sync/src/suggest/records.ts';
import { payloadDocsFor, payloadText } from '../../../../../../packages/sync/src/payload-docs.ts';
import { REGISTER_LOCAL_ORIGIN } from '../../../../../../packages/sync/src/registers.ts';
import {
  acceptRecord, exportWorkingMarkdown, nodeRegistry, previewRecord, rejectRecord, withdrawRecord,
} from '../../../../../../packages/sync/src/suggest/review.ts';
import { deterministicIds, EDITOR, exported, NOTE_ID, seededBody, select, SUGGESTER, textNode } from '../../../../../../packages/sync/src/suggest/test-support.ts';
import { publishBinding } from '../binding-registry.ts';
import { createBindingUndoManager } from '../undo.ts';
import { captureCaret } from './caret.ts';
import { charWork, textIds } from './chars.ts';
import { drawGhosts, ghostsOf, struckByRecord } from './paint.ts';
import { rebuildWork, registerSuggestRouting } from './routing.ts';
import { traceWork } from './trace.ts';

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

/**
 * A suggester's pane: a moss editor bound to F, with the routing, the body's undo stack and a native Backspace.
 * `dom`: the editor renders into a root element, as the pane's does.
 */
function suggesting(markdown: string, options: { dom?: boolean } = {}) {
  const live = seededBody(markdown);
  const link = wire(live);
  const fork = new SuggestFork(live, { me: SUGGESTER.id, name: SUGGESTER.name, send: link.send, now: () => 1_000 });
  let root: HTMLElement | null = null;
  let domEditor: LexicalEditor | undefined;
  if (options.dom) {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    domEditor = createEditor({ namespace: 'routing-dom', nodes: MARKDOWN_EDITOR_NODES, onError: (error) => { throw error; } });
    domEditor.setRootElement(root);
  }
  const bound = bindEditor(fork.doc, domEditor);
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
    /** Rich-text paste of `html` at the selection, as moss's paste of text/html runs it. */
    paste: (html: string) => run(() => {
      const dom = new DOMParser().parseFromString(html, 'text/html');
      $insertGeneratedNodes(editor, $generateNodesFromDOM(editor, dom), $getSelection()!);
    }),
    /** Any native edit, as one keystroke. */
    edit: run,
    /** What the suggester sees in F. */
    text: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
    editor,
    binding: bound.binding,
    dispose: () => {
      for (const stop of stops) stop();
      undo.destroy();
      bound.dispose();
      fork.dispose();
      if (root) {
        editor.setRootElement(null);
        root.remove();
      }
    },
  };
}

type Pane = ReturnType<typeof suggesting>;

/** The one record, its card's inserted and deleted texts, the working export, and the text accept lands. */
function reviewed(pane: Pane) {
  expect(pane.replies.filter((reply) => reply.t === 'suggest-refused'), 'never refused').toEqual([]);
  // A record merged into another closes as withdrawn: the open one carries everything.
  const ids = recordIds(pane.live).filter((id) => readRecord(pane.live, id)?.meta.status === 'open');
  expect(ids, 'one open suggestion').toHaveLength(1);
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

  it('adjacent strikes made right to left, a join, then full undo: the block comes back in order; redo and undo again, then accept', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 2);
      pane.press('Backspace');
      pane.press('Backspace');
      expect(pane.fork.struck().reduce((sum, span) => sum + span.len, 0), "'b', then 'a'").toBe(2);
      pane.press('Backspace');
      expect(pane.text()).toBe('Intro line stays.c tail.\n\nClosing line stays too.');
      pane.undo();
      pane.undo();
      pane.undo();
      expect(pane.text(), 'every character back, in order').toBe('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
      expect(pane.fork.struck(), 'nothing struck').toEqual([]);
      pane.redo();
      pane.redo();
      pane.redo();
      expect(pane.text(), 'redo of all three').toBe('Intro line stays.c tail.\n\nClosing line stays too.');
      pane.undo();
      pane.undo();
      pane.undo();
      expect(pane.text(), 'and back once more, in order').toBe('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { working, body } = reviewed(pane);
    expect(working).toContain('Intro line stays.\n\nabc tail.');
    expect(body, 'accept lands the original text').toBe(exported(seededBody(NOTE)));
  });

  it('adjacent strikes made right to left in a list item, an unwrap or join, then full undo: the item comes back in order', () => {
    const LIST = '- alpha item\n- beta item\n- gamma item\n';
    const pane = suggesting(LIST);
    try {
      pane.caret('beta', 2);
      pane.press('Backspace');
      pane.press('Backspace');
      pane.press('Backspace');
      expect(pane.text()).not.toContain('be');
      expect(pane.text()).toContain('ta item');
      pane.undo();
      pane.undo();
      pane.undo();
      expect(pane.text(), 'the item back, in order').toContain('beta item');
      pane.redo();
      pane.redo();
      pane.redo();
      expect(pane.text()).not.toContain('be');
      pane.undo();
      pane.undo();
      pane.undo();
      expect(pane.text()).toContain('beta item');
    } finally {
      pane.dispose();
    }
    const { body } = reviewed(pane);
    expect(body, 'accept lands the original list').toBe(exported(seededBody(LIST)));
  });

  it('Backspace beside an empty paragraph removes that paragraph only: strikes either side of live text stay valid', () => {
    const BOLD = 'Intro line stays.\n\na**b**c tail.\n\nClosing line stays too.\n';
    const pane = suggesting(BOLD);
    try {
      pane.caret('c tail', 1);
      pane.press('Backspace');
      pane.caret('a', 1);
      pane.press('Backspace');
      expect(pane.fork.struck(), "'c' and 'a'").toHaveLength(2);
      pane.caret('Intro', 'Intro line stays.'.length);
      pane.edit(() => {
        ($getSelection() as RangeSelection).insertParagraph();
      });
      expect(pane.text(), 'an empty paragraph').toBe('Intro line stays.\n\n\n\nabc tail.\n\nClosing line stays too.');
      pane.caret('a', 0);
      pane.press('Backspace');
      expect(pane.text(), 'the empty paragraph went; the block and its struck text stay').toBe('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
      expect(pane.fork.struck(), 'both strikes stand').toHaveLength(2);
    } finally {
      pane.dispose();
    }
    const { record, working, body } = reviewed(pane);
    expect(record.parts, 'both strikes are parts').toHaveLength(2);
    expect(working).toContain('Intro line stays.\n\n**b** tail.');
    expect(body, 'accept removes only the struck characters').toContain('Intro line stays.\n\n**b** tail.\n\nClosing line stays too.');
  });

  it('Delete in an empty paragraph removes that paragraph only: strikes in the block after it stay valid', () => {
    const BOLD = 'Intro line stays.\n\na**b**c tail.\n\nClosing line stays too.\n';
    const pane = suggesting(BOLD);
    try {
      pane.caret('c tail', 1);
      pane.press('Backspace');
      pane.caret('a', 1);
      pane.press('Backspace');
      expect(pane.fork.struck(), "'c' and 'a'").toHaveLength(2);
      pane.caret('Intro', 'Intro line stays.'.length);
      pane.edit(() => {
        ($getSelection() as RangeSelection).insertParagraph();
      });
      expect(pane.text(), 'an empty paragraph, the caret in it').toBe('Intro line stays.\n\n\n\nabc tail.\n\nClosing line stays too.');
      pane.press('Delete');
      expect(pane.text(), 'the empty paragraph went; the block after it and its struck text stay').toBe('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
      expect(pane.fork.struck(), 'both strikes stand').toHaveLength(2);
    } finally {
      pane.dispose();
    }
    const { record, body } = reviewed(pane);
    expect(record.parts, 'both strikes are parts').toHaveLength(2);
    expect(body, 'accept removes only the struck characters').toContain('Intro line stays.\n\n**b** tail.\n\nClosing line stays too.');
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

describe('a rewrite that also inserts text equal to the struck text keeps the strike on the moved copy, never on the new text @p:mean-2 @p:R17', () => {
  it("paste of '<p>a</p><p>x</p>' at the start of a block whose struck 'a' moves: the pasted 'a' stays, the struck one stays out", () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.caret('abc', 0);
      pane.paste('<p>a</p><p>x</p>');
      expect(pane.text(), 'F: the pasted "a" in its own block, the moved block without the struck "a"').toBe('Intro line stays.\n\na\n\nxbc tail.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join('|'), 'the card adds the pasted "a" and the moved text without the struck one').not.toContain('xabc');
    expect(working).toContain('Intro line stays.\n\na\n\nxbc tail.');
    expect(body, 'accept keeps the pasted "a" and leaves the struck one out').toContain('Intro line stays.\n\na\n\nxbc tail.\n\nClosing line stays too.');
  });

  it("paste of '<p>b</p><p>x</p>' just before a struck 'b': the pasted 'b' stays where it went, the struck one stays out of the moved block", () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 2);
      pane.press('Backspace');
      pane.caret('abc', 1);
      pane.paste('<p>b</p><p>x</p>');
      expect(pane.text()).toBe('Intro line stays.\n\nab\n\nxc tail.\n\nClosing line stays too.');
    } finally {
      pane.dispose();
    }
    const { working, body } = reviewed(pane);
    expect(working).toContain('Intro line stays.\n\nab\n\nxc tail.');
    expect(body).toContain('Intro line stays.\n\nab\n\nxc tail.\n\nClosing line stays too.');
  });

  it('undo of that paste takes the pasted text back and the strike stands', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 2);
      pane.press('Backspace');
      pane.caret('abc', 1);
      pane.paste('<p>b</p><p>x</p>');
      pane.undo();
      expect(pane.text(), 'the paste taken back').not.toContain('x');
      expect(pane.text()).not.toContain('abc');
    } finally {
      pane.dispose();
    }
    const { body } = reviewed(pane);
    expect(body, 'accept: only the struck "b" goes').toContain('Intro line stays.\n\nac tail.\n\nClosing line stays too.');
  });
});

/**
 * As @lexical/markdown runs a text-match transformer on its trigger, with moss's highlight transformer's replace;
 * `unescape`: its text unescaped, as moss's unescapeInlineMarkdownText reads `\*`.
 */
const $highlight = (match: string, unescape = false) => {
  const node = textNode(match);
  const [matched] = node.splitText(match.length);
  const inner = match.slice(2, -2);
  const highlighted = $createTextNode(unescape ? inner.replace(/\\(.)/g, '$1') : inner);
  highlighted.setFormat(matched.getFormat());
  highlighted.setStyle('background-color: var(--highlight-yellow); --obsidian-highlight: true');
  matched.replace(highlighted);
};

/** Strike "b" of "abc tail.", then type "==" either side of "abc" and run the highlight shortcut. */
function highlighted(pane: Pane): void {
  pane.caret('abc', 2);
  pane.press('Backspace');
  pane.caret('abc', 0);
  pane.edit(() => ($getSelection() as RangeSelection).insertText('=='));
  pane.caret('==abc', 5);
  pane.edit(() => ($getSelection() as RangeSelection).insertText('=='));
  pane.edit(() => $highlight('==abc=='));
}

describe('a rewrite that rebuilds a text node from its text keeps the struck character out of the new node @p:mean-2 @p:R17', () => {
  it("the '==' highlight shortcut replaces '==abc==' with a new 'abc' node: the struck 'b' stays out of it, of the card and of accept", () => {
    const pane = suggesting(NOTE);
    try {
      highlighted(pane);
      expect(pane.text(), 'F: highlighted, without the struck "b"').not.toContain('abc');
      expect(pane.text()).toContain('ac tail.');
    } finally {
      pane.dispose();
    }
    const { record, inserted, working, body } = reviewed(pane);
    expect(record.parts, 'the strike stays a part').toHaveLength(1);
    expect(inserted.join('|'), 'the card adds the highlighted text without the struck "b"').not.toContain('b');
    expect(working).not.toContain('abc');
    expect(body, 'accept leaves the struck "b" out').not.toContain('abc');
    expect(body, 'and keeps the rest').toContain('ac== tail.');
    expect(body).toContain('Closing line stays too.');
  });

  it('undo and redo of the highlight shortcut, then accept: the struck "b" stays out', () => {
    for (const steps of [['undo'], ['undo', 'redo']] as const) {
      const pane = suggesting(NOTE);
      try {
        highlighted(pane);
        for (const step of steps) pane[step]();
        expect(pane.text(), `${steps.join(', ')}: the struck "b" is not re-created live`).not.toMatch(/a=*b/);
      } finally {
        pane.dispose();
      }
      const { working, body } = reviewed(pane);
      expect(working, steps.join(', ')).not.toMatch(/a[\\=]*b/);
      expect(body, `${steps.join(', ')}: accept leaves the struck "b" out`).not.toMatch(/a[\\=]*b/);
      expect(body, steps.join(', ')).toMatch(/a[\\=]*c/);
      expect(body).toContain('tail.');
    }
  });

  it("a wiki-link pick cuts the text after the caret into a new node: the struck 'b' stays out of it, of the card and of accept", () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 2);
      pane.press('Backspace');
      pane.caret('abc', 1);
      pane.edit(() => ($getSelection() as RangeSelection).insertText('[[In'));
      // As moss's FileLinkTypeaheadPlugin inserts the picked link (FileLinkTypeaheadPlugin.tsx 225-239).
      pane.edit(() => {
        const anchor = textNode('a[[In');
        const afterCursor = anchor.getTextContent().slice('a[[In'.length);
        anchor.setTextContent('a');
        // moss's FileLinkNode, as $createFileLinkNode(null, '', true, heading, 'fully_resolved') makes it.
        const link = $parseSerializedNode({
          type: 'file-link', version: 1, noteId: null, noteTitle: '', isResolved: true, headingText: 'Intro line stays.', resolutionState: 'fully_resolved', displayText: null,
        } as SerializedLexicalNode);
        anchor.insertAfter(link);
        link.insertAfter(new TextNode(afterCursor));
        const space = new TextNode(' ');
        link.insertAfter(space);
        space.select();
      });
      expect(pane.text(), 'F: the link, without the struck "b" after it').not.toMatch(/b ?c tail/);
      expect(pane.text()).toContain('c tail.');
    } finally {
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join('|'), 'the card adds the cut text without the struck "b"').not.toMatch(/bc tail/);
    expect(working).not.toMatch(/bc tail/);
    expect(body, 'accept leaves the struck "b" out').not.toMatch(/bc tail/);
    expect(body, 'and keeps the rest').toContain('c tail.');
    expect(body).toContain('Closing line stays too.');
  });
});

describe("the strike's undo bookkeeping stays in the body: a payload field's undo is untouched @p:mean-2", () => {
  it('a payload character whose id equals a struck body original still comes back on undo', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.press('Backspace');
      expect(pane.text()).toBe('Intro line stays.bc tail.\n\nClosing line stays too.');
      const [original] = pane.fork.struck();
      // A payload doc whose item ids collide with the struck body original: same client, same clock.
      const payload = payloadDocsFor(pane.fork.doc).hold('p-collide', true);
      payload.clientID = original.client;
      payload.transact(() => payloadText(payload).insert(0, 'q'.repeat(original.clock + 1)), 'seed');
      expect(Y.getState(payload.store, original.client)).toBe(original.clock + 1);
      payload.transact(() => payloadText(payload).delete(original.clock, 1), REGISTER_LOCAL_ORIGIN);
      expect(payloadText(payload).length).toBe(original.clock);
      pane.editor.update(() => {
        pane.editor.dispatchCommand(UNDO_COMMAND, undefined);
      }, { discrete: true });
      expect(payloadText(payload).length, 'undo restores the payload character').toBe(original.clock + 1);
    } finally {
      pane.dispose();
    }
  });
});

// The census: every block kind on each side of a boundary, every edge key and every strike position. Struck text is
// upper case and nothing else is, so the struck characters are the note's capitals and the rest is its lower case.
type Kind =
  | 'paragraph' | 'heading' | 'leading heading' | 'list item' | 'nested list item' | 'quote' | 'code block' | 'table'
  | 'decorator' | 'empty paragraph' | 'line break';
const KINDS: Kind[] = [
  'paragraph', 'heading', 'leading heading', 'list item', 'nested list item', 'quote', 'code block', 'table', 'decorator', 'empty paragraph', 'line break',
];
/** The kind is the block before the boundary, or the block after it. */
type Side = 'before' | 'after';
type Key = 'Backspace at the start' | 'Delete at the end' | 'Delete after a line break';
const KEYS: Key[] = ['Backspace at the start', 'Delete at the end', 'Delete after a line break'];
/**
 * start: the next block's first character; end: each block's last; span: across the boundary; whole: the next block;
 * apart: the next block's first and last, live text between them.
 */
type Where = 'start' | 'end' | 'span' | 'whole' | 'apart';
const WHERES: Where[] = ['start', 'end', 'span', 'whole', 'apart'];
const TEXTLESS = new Set<Kind>(['code block', 'decorator', 'empty paragraph']);
const B_TEXT: Record<Where, string> = { start: 'Zbeta tail', span: 'Zbeta tail', end: 'beta tailZ', whole: 'ZQZQZQ', apart: 'Zbeta tailZ' };

interface Shape {
  markdown: string;
  /** The text of the block before the boundary and of the block after it, when they hold text. */
  a: string | null;
  b: string | null;
  /** An empty paragraph made before the strikes: after the intro (the block before) or after `a` (the block after). */
  empty: 'a' | 'b' | null;
  hasA: boolean;
  aKind: Kind | null;
  bKind: Kind;
}

function blockOf(kind: Kind, text: string | null, role: 'a' | 'b'): string {
  switch (kind) {
    case 'paragraph': return text!;
    case 'heading':
    case 'leading heading': return `## ${text}`;
    case 'list item': return `- ${text}`;
    case 'nested list item': return `- outer keep\n    - ${text}`;
    case 'quote': return `> ${text}`;
    case 'table': return role === 'a' ? `| cell keep | row keep |\n| --- | --- |\n| more keep | ${text} |` : `| ${text} | cell keep |\n| --- | --- |\n| more keep | row keep |`;
    case 'code block': return '```\n123\n```';
    case 'decorator': return '---';
    case 'line break': return role === 'a' ? `first keep\n${text}` : `${text}\nsecond keep`;
    case 'empty paragraph': return '';
  }
}

function shapeOf(kind: Kind, side: Side, where: Where): Shape {
  const leading = kind === 'leading heading';
  const aKind: Kind | null = side === 'before' ? kind : leading ? null : 'paragraph';
  const bKind: Kind = side === 'after' ? kind : 'paragraph';
  const a = aKind && !TEXTLESS.has(aKind) ? (where === 'end' || where === 'span' ? 'alpha headZ' : 'alpha head') : null;
  const b = TEXTLESS.has(bKind) ? null : B_TEXT[where];
  const blocks: string[] = [];
  if (!leading) blocks.push('intro keep.');
  if (bKind === 'nested list item') {
    // Its parent item is the block before it.
    blocks.push(`- ${a}\n    - ${b}`);
  } else {
    if (aKind && aKind !== 'empty paragraph') blocks.push(blockOf(aKind, a, 'a'));
    if (bKind !== 'empty paragraph') blocks.push(blockOf(bKind, b, 'b'));
  }
  blocks.push('closing keep.');
  const empty = aKind === 'empty paragraph' ? 'a' : bKind === 'empty paragraph' ? 'b' : null;
  return { markdown: `${blocks.join('\n\n')}\n`, a, b, empty, hasA: aKind !== null, aKind, bKind };
}

/** Why a combination does not apply, or null. */
function skipOf(shape: Shape, key: Key, where: Where): string | null {
  const caretless = (kind: Kind | null) => kind === 'code block' || kind === 'decorator';
  if (key === 'Backspace at the start' && caretless(shape.bKind)) return 'no caret in the block after';
  if (key !== 'Backspace at the start' && (!shape.hasA || caretless(shape.aKind))) return 'no caret in the block before';
  if ((where === 'start' || where === 'whole' || where === 'apart') && !shape.b) return 'nothing to strike';
  if (where === 'span' && (!shape.a || !shape.b)) return 'nothing to strike across';
  if (where === 'end' && !shape.a && !shape.b) return 'nothing to strike';
  return null;
}

/** The unstruck text: lower case letters, and the digits of code. */
const letters = (text: string) => text.replace(/[^a-z0-9]/g, '');
const capitals = (text: string) => text.replace(/[^A-Z]/g, '');

/** F's capitals that are not struck: each one F shows must be painted struck. */
function unstruckCapitals(pane: Pane): string[] {
  return pane.editor.getEditorState().read(() => {
    const out: string[] = [];
    const visit = (node: LexicalNode) => {
      if ($isTextNode(node)) {
        const text = node.getTextContent();
        const ids = textIds(pane.binding, node.getKey());
        for (let i = 0; i < text.length; i += 1) {
          if (!/[A-Z]/.test(text[i])) continue;
          if (!ids || !pane.fork.isStruck(ids[i])) out.push(`${text[i]} in "${text}"`);
        }
      }
      if ($isElementNode(node)) for (const child of node.getChildren()) visit(child);
    };
    visit($getRoot());
    return out;
  });
}

/** Every live character of a Yjs tree, with its id. */
function liveChars(type: Y.AbstractType<unknown>, out: { id: Y.ID; char: string }[] = []) {
  for (let item = type._start; item; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentString) {
      const { str } = item.content;
      for (let i = 0; i < str.length; i += 1) out.push({ id: Y.createID(item.id.client, item.id.clock + i), char: str[i] });
    } else if (item.content instanceof Y.ContentType && item.parentSub === null) liveChars(item.content.type as Y.AbstractType<unknown>, out);
  }
  return out;
}

const within = (spans: readonly IdSpan[], id: Y.ID) => spans.some((span) => span.client === id.client && span.clock <= id.clock && id.clock < span.clock + span.len);

/**
 * One combination, from the strikes to accept: the problems found, `browser` when its key runs only in a browser, or
 * null when it does not apply.
 */
function census(kind: Kind, side: Side, key: Key, where: Where): string[] | 'browser' | null {
  const shape = shapeOf(kind, side, where);
  if (skipOf(shape, key, where)) return null;
  const problems: string[] = [];
  const original = letters(exported(seededBody(shape.markdown)));
  const pane = suggesting(shape.markdown);
  let shown = letters(pane.text());
  // After an undo the struck capitals may be live again: undo takes back the strike when the key changed nothing.
  const look = (when: string, struck = true) => {
    if (struck) for (const capital of unstruckCapitals(pane)) problems.push(`${when}: F shows ${capital} unstruck`);
    if (letters(pane.text()) !== shown) problems.push(`${when}: F lost unstruck text: ${JSON.stringify(pane.text())}`);
  };
  const emptyParagraph = () => $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContentSize() === 0);
  try {
    if (shape.empty === 'a') {
      pane.caret('intro keep.', 'intro keep.'.length);
      pane.edit(() => ($getSelection() as RangeSelection).insertParagraph());
    } else if (shape.empty === 'b') {
      pane.caret(shape.a!, shape.a!.length);
      pane.edit(() => ($getSelection() as RangeSelection).insertParagraph());
    }
    shown = letters(pane.text());
    if (where === 'start') {
      pane.caret(shape.b!, 1);
      pane.press('Backspace');
    } else if (where === 'whole') {
      pane.caret(shape.b!, 0, shape.b!.length);
      pane.press('Backspace');
    } else if (where === 'apart') {
      pane.caret(shape.b!, 1);
      pane.press('Backspace');
      pane.caret(shape.b!, shape.b!.length);
      pane.press('Backspace');
    } else if (where === 'span') {
      pane.across(shape.a!, shape.a!.length - 1, shape.b!, 1);
      pane.press('Backspace');
    } else {
      for (const text of [shape.a, shape.b]) {
        if (!text) continue;
        pane.caret(text, text.length);
        pane.press('Backspace');
      }
    }
    const struck = pane.fork.struck().reduce((sum, span) => sum + span.len, 0);
    const expected = capitals([shape.a, shape.b].join(' ')).length;
    if (struck !== expected) problems.push(`struck ${struck} characters, not ${expected}`);
    look('after the strikes');
    // A key whose native path reads the DOM selection (a table cell's edge, nothing before) runs only in a browser:
    // the real-app census (e2e/lib/strike-census.ts) covers it.
    const native = (step: () => void): boolean => {
      try {
        step();
        return true;
      } catch (error) {
        if (String(error).includes('window object not found')) return false;
        throw error;
      }
    };
    if (key === 'Backspace at the start') {
      if (shape.b) pane.caret(shape.b, 0);
      else pane.edit(() => emptyParagraph()!.selectStart());
      if (!native(() => pane.press('Backspace'))) return 'browser';
    } else {
      if (shape.a) pane.caret(shape.a, shape.a.length);
      else pane.edit(() => emptyParagraph()!.selectStart());
      if (key === 'Delete after a line break') pane.edit(() => ($getSelection() as RangeSelection).insertLineBreak());
      if (!native(() => pane.press('Delete'))) return 'browser';
    }
    look(`after ${key}`);
    pane.undo();
    look(`after undo of ${key}`, pane.fork.struck().reduce((sum, span) => sum + span.len, 0) === expected);
    pane.redo();
    look(`after redo of ${key}`);
  } finally {
    pane.dispose();
  }
  const refused = pane.replies.filter((reply) => reply.t === 'suggest-refused');
  if (refused.length) problems.push(`refused: ${JSON.stringify(refused)}`);
  const open = recordIds(pane.live)
    .map((id) => readRecord(pane.live, id)!)
    .filter((record) => record.meta.status === 'open')
    .sort((x, y) => x.meta.createdAt - y.meta.createdAt || (x.meta.id < y.meta.id ? -1 : 1));
  // Edit mode: every capital in the body paints struck, and nothing a record inserts holds one.
  const built = new Composite(pane.live).build();
  try {
    if (built.valid.length !== open.length) problems.push(`records invalid in C: ${built.broken.join(', ')}`);
    const spans = [...struckByRecord(pane.live, new Set(built.valid), built).values()].flat();
    for (const { id, char } of liveChars(pane.live.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>)) {
      if (/[A-Z]/.test(char) && !within(spans, id)) problems.push(`Edit mode leaves ${char} unpainted`);
    }
    for (const { id, char } of liveChars(built.doc.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>)) {
      if (/[A-Z]/.test(char) && built.clients.has(id.client)) problems.push(`C inserts ${char}`);
    }
  } finally {
    destroyView(built);
  }
  const working = exportWorkingMarkdown(pane.live, NOTE_ID);
  if (capitals(working)) problems.push(`the working export holds ${capitals(working)}`);
  if (letters(working) !== original) problems.push(`the working export lost unstruck text: ${JSON.stringify(working)}`);
  for (const record of open) {
    const preview = previewRecord(pane.live, record.meta.id);
    if (!preview.ok) {
      problems.push(`preview: ${JSON.stringify(preview)}`);
      continue;
    }
    for (const row of describeHunks(preview.hunks)) {
      if (row.kind === 'insert' && capitals(row.text)) problems.push(`the card adds ${JSON.stringify(row.text)}`);
    }
    const accepted = acceptRecord(pane.live, record.meta.id, { previewHash: preview.hash, digest: preview.digest }, EDITOR);
    if (!accepted.ok) problems.push(`accept: ${JSON.stringify(accepted)}`);
  }
  const body = exported(pane.live);
  if (capitals(body)) problems.push(`accept keeps ${capitals(body)}: ${JSON.stringify(body)}`);
  if (letters(body) !== original) problems.push(`accept lost unstruck text: ${JSON.stringify(body)}`);
  return problems;
}

describe('the strike census: every block kind on each side of a boundary, every edge key, every strike position @p:mean-2 @p:R17', () => {
  for (const kind of KINDS) {
    for (const side of ['before', 'after'] as const) {
      it(`${kind} ${side} the boundary: F, the card, the Edit-mode paint, the working export and accept leave every struck character out and keep the rest`, () => {
        const failures: string[] = [];
        let ran = 0;
        for (const key of KEYS) {
          for (const where of WHERES) {
            let problems: string[] | 'browser' | null;
            try {
              problems = census(kind, side, key, where);
            } catch (error) {
              problems = [`threw ${(error as Error).stack ?? String(error)}`];
            }
            if (problems === null) continue;
            ran += 1;
            if (problems === 'browser') continue;
            for (const problem of problems) failures.push(`${key}, strike ${where}: ${problem}`);
          }
        }
        expect(ran, 'combinations run').toBeGreaterThan(0);
        expect(failures).toEqual([]);
      });
    }
  }
});

// Whole-repo Slop Cop P1 (T5.S3): Backspace past a long struck run reads the node's ids and graphemes once, not once
// per struck character, and still strikes only the whole live grapheme before it.
describe('Backspace past a long struck run is linear and strikes the whole grapheme before it @p:mean-2 @p:R17', () => {
  const filler = (length: number) => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(length / 27)).slice(0, length);
  const struckLength = (pane: Pane) => pane.fork.struck().reduce((sum, span) => sum + span.len, 0);
  /** Strikes `size` characters after `ab` + `grapheme` with one range delete, then presses Backspace at their end. */
  const strikeThenBackspace = (pane: Pane, grapheme: string, size: number, own = '') => {
    const start = 2 + grapheme.length;
    pane.caret('ab', start, start + size);
    pane.press('Backspace');
    expect(struckLength(pane), 'the range strike').toBe(size);
    if (own) {
      pane.caret('ab', start);
      pane.edit(() => ($getSelection() as RangeSelection).insertText(own));
    }
    pane.caret('ab', start + own.length + size);
    charWork.steps = 0;
    pane.press('Backspace');
    return charWork.steps;
  };

  it('5,000, 10,000 and 20,000 struck characters: the work grows linearly, and only the combining mark or surrogate pair before them is struck', () => {
    const work = new Map<number, number>();
    for (const size of [5_000, 10_000, 20_000]) {
      for (const grapheme of ['é', '\u{1F600}']) {
        const line = `ab${grapheme}${filler(size)} tail.`;
        const pane = suggesting(`Intro line stays.\n\n${line}\n`);
        try {
          const steps = strikeThenBackspace(pane, grapheme, size);
          expect(steps, `work for ${size} struck characters`).toBeLessThanOrEqual(40 * line.length);
          work.set(size, Math.max(work.get(size) ?? 0, steps));
          expect(pane.text(), 'F keeps every character').toBe(`Intro line stays.\n\n${line}`);
          expect(struckLength(pane), 'the whole grapheme, both code units').toBe(size + 2);
          pane.editor.getEditorState().read(() => {
            const node = textNode('ab');
            const ids = textIds(pane.binding, node.getKey())!;
            expect(pane.fork.isStruck(ids[1]), "'b' stays live").toBe(false);
            expect(pane.fork.isStruck(ids[2]) && pane.fork.isStruck(ids[3]), 'the grapheme is struck').toBe(true);
            const selection = $getSelection() as RangeSelection;
            expect([selection.anchor.key, selection.anchor.offset], 'the caret before the grapheme').toEqual([node.getKey(), 2]);
          });
        } finally {
          pane.dispose();
        }
      }
    }
    expect(work.get(20_000)! / work.get(5_000)!, 'four times the strike, at most about four times the work').toBeLessThan(6);
  });

  it("the author's own character before a long struck run deletes natively, with linear work", () => {
    const size = 5_000;
    const line = `ab\u{1F600}${filler(size)} tail.`;
    const pane = suggesting(`Intro line stays.\n\n${line}\n`);
    // The native Backspace the routing hands over to, and where it gets the caret: the harness editor has no DOM window.
    const native: number[] = [];
    const stop = pane.editor.registerCommand(DELETE_CHARACTER_COMMAND, () => {
      const selection = $getSelection() as RangeSelection;
      native.push(selection.anchor.offset);
      (selection.anchor.getNode() as TextNode).spliceText(selection.anchor.offset - 1, 1, '', true);
      return true;
    }, COMMAND_PRIORITY_HIGH);
    try {
      const steps = strikeThenBackspace(pane, '\u{1F600}', size, 'Q');
      expect(steps).toBeLessThanOrEqual(40 * line.length);
      expect(native, "handed over just after the own 'Q'").toEqual([5]);
      expect(pane.text(), 'the own character is gone, the body stays').toBe(`Intro line stays.\n\n${line}`);
      expect(struckLength(pane), 'nothing more struck').toBe(size);
    } finally {
      stop();
      pane.dispose();
    }
  });
});

const openIds = (live: Y.Doc) => recordIds(live).filter((id) => readRecord(live, id)?.meta.status === 'open');

/** Accepts every open record, each as previewed. */
function acceptAll(live: Y.Doc): void {
  for (const id of openIds(live)) {
    const preview = previewRecord(live, id);
    if (!preview.ok) throw new Error(`preview of ${id} refused`);
    expect(acceptRecord(live, id, { previewHash: preview.hash, digest: preview.digest }, EDITOR), `accept ${id}`).toEqual({ ok: true });
  }
}

// B285: a continuation writes on under an accepted record's lease, so an own client's items are pending only past what
// the body holds of that client.
describe("an accepted record's text, under a lease the fork still writes, is body text @p:mean-2 @p:R17", () => {
  const idsOf = (pane: Pane) => pane.editor.getEditorState().read(() => textIds(pane.binding, textNode('abc').getKey())!);
  /** "XYZ" typed after "abc tail." is accepted while "W" typed after it is in flight; "W" lands in a continuation. */
  const acceptedPrefix = (pane: Pane) => {
    pane.caret('abc', 9);
    pane.edit(() => ($getSelection() as RangeSelection).insertText('XYZ'));
    const [record] = openIds(pane.live);
    pane.editor.update(() => ($getSelection() as RangeSelection).insertText('W'), { discrete: true });
    pane.editor.update(() => {}, { discrete: true });
    const preview = previewRecord(pane.live, record);
    if (!preview.ok) throw new Error('no preview');
    expect(acceptRecord(pane.live, record, { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
    pane.edit(() => {});
    expect(pane.replies.filter((reply) => reply.t === 'suggest-refused'), 'never refused').toEqual([]);
    expect(pane.text()).toContain('abc tail.XYZW');
    const [, y, z, w] = idsOf(pane).slice(9, 13);
    expect(w.client, 'the continuation writes under the accepted lease').toBe(y.client);
    expect(pane.fork.ownClients().has(y.client), "that lease is still the author's").toBe(true);
    return { y, z };
  };

  it('Backspace on the accepted prefix strikes it, never deletes it natively, and accept removes it', () => {
    const pane = suggesting(NOTE);
    try {
      const { y } = acceptedPrefix(pane);
      pane.caret('abc', 11);
      pane.press('Backspace');
      expect(pane.fork.struck(), 'a strike of the accepted "Y"').toEqual([{ client: y.client, clock: y.clock, len: 1 }]);
      expect(pane.text(), 'F keeps it, struck').toContain('abc tail.XYZW');
    } finally {
      pane.dispose();
    }
    expect(pane.replies.filter((reply) => reply.t === 'suggest-refused'), 'never refused').toEqual([]);
    acceptAll(pane.live);
    expect(exported(pane.live)).toContain('abc tail.XZW');
  });

  it('a mode switch keeps the caret on the accepted prefix, not on the body text before it', () => {
    const pane = suggesting(NOTE);
    try {
      const { y, z } = acceptedPrefix(pane);
      pane.caret('abc', 11);
      expect(captureCaret(pane.editor, pane.fork.ownClients(), pane.live), 'just after "Y"').toEqual({ client: y.client, clock: y.clock, after: true });
      pane.caret('abc', 13);
      expect(captureCaret(pane.editor, pane.fork.ownClients(), pane.live), 'past the pending "W", after "Z"').toEqual({ client: z.client, clock: z.clock, after: true });
    } finally {
      pane.dispose();
    }
  });
});

// B284: the body's undo stack replays a native step as a new stack item; only a new edit ends the strikes' redo.
describe('native undo steps between strikes keep the strikes redoable @p:mean-2 @p:R17', () => {
  const managerOf = (pane: Pane) => (pane.editor as unknown as Record<symbol, { stopCapturing(): void }>)[Symbol.for('@lexical/yjs/UndoManager')];
  const sorted = (spans: readonly IdSpan[]) => [...spans].sort((x, y) => x.client - y.client || x.clock - y.clock);

  it('strikes between native body and payload edits: undo all, redo all, and every strike is redone', () => {
    const pane = suggesting(NOTE);
    try {
      const payload = payloadDocsFor(pane.fork.doc).hold('p-redo', true);
      const steps: (() => void)[] = [
        () => {
          pane.caret('abc', 1);
          pane.press('Backspace');
        },
        () => {
          pane.caret('Closing', 23);
          pane.edit(() => ($getSelection() as RangeSelection).insertText('Q'));
        },
        () => {
          pane.caret('abc', 3);
          pane.press('Backspace');
        },
        () => {
          payload.transact(() => payloadText(payload).insert(0, 'z'), REGISTER_LOCAL_ORIGIN);
          pane.edit(() => {});
        },
        () => {
          pane.caret('Intro', 1);
          pane.press('Backspace');
        },
      ];
      for (const step of steps) {
        managerOf(pane).stopCapturing();
        step();
      }
      const struck = sorted(pane.fork.struck());
      expect(struck.reduce((sum, span) => sum + span.len, 0), 'three strikes').toBe(3);
      const text = pane.text();
      for (let i = 0; i < steps.length; i += 1) pane.undo();
      expect(pane.fork.struck(), 'undo took every strike back').toEqual([]);
      expect(payloadText(payload).toString(), 'and the payload edit').toBe('');
      expect(pane.text(), 'and the body edit').not.toContain('Q');
      for (let i = 0; i < steps.length; i += 1) pane.redo();
      expect(sorted(pane.fork.struck()), 'redo put every strike back').toEqual(struck);
      expect(payloadText(payload).toString()).toBe('z');
      expect(pane.text()).toBe(text);
    } finally {
      pane.dispose();
    }
    expect(pane.replies.filter((reply) => reply.t === 'suggest-refused'), 'never refused').toEqual([]);
  });

  it('a new edit after an undo still ends the strike redo', () => {
    const pane = suggesting(NOTE);
    try {
      pane.caret('abc', 1);
      pane.press('Backspace');
      pane.undo();
      expect(pane.fork.struck()).toEqual([]);
      managerOf(pane).stopCapturing();
      pane.caret('Closing', 23);
      pane.edit(() => ($getSelection() as RangeSelection).insertText('Q'));
      pane.redo();
      expect(pane.fork.struck(), 'nothing to redo').toEqual([]);
    } finally {
      pane.dispose();
    }
  });
});

// B300, B301: a rewrite that rebuilds a text node from its text carries each character's identity by offset, whatever
// the run's length and however short the match.
describe('a highlight rewrite carries each struck character by offset @p:mean-2 @p:R17', () => {
  it("strike the lone 'x' of 'x tail x.', type '==' either side and highlight: F, the card, the working export and accept never bring it back", () => {
    const pane = suggesting('Intro line stays.\n\nx tail x.\n\nClosing line stays too.\n');
    try {
      pane.caret('x tail', 1);
      pane.press('Backspace');
      pane.caret('x tail', 0);
      pane.edit(() => ($getSelection() as RangeSelection).insertText('=='));
      pane.caret('==x', 3);
      pane.edit(() => ($getSelection() as RangeSelection).insertText('=='));
      pane.edit(() => $highlight('==x=='));
      expect(pane.text(), 'F: highlighted, without the struck "x"').not.toMatch(/x=* tail/);
      expect(pane.text(), 'the other "x" stays').toContain(' tail x.');
    } finally {
      pane.dispose();
    }
    const { record, inserted, working, body } = reviewed(pane);
    expect(record.parts, 'the strike stays a part').toHaveLength(1);
    expect(inserted.join('|'), 'the card adds no "x"').not.toContain('x');
    expect(working).not.toMatch(/x[\\=]* tail/);
    expect(body, 'accept leaves the struck "x" out').not.toMatch(/x[\\=]* tail/);
    expect(body, 'and keeps the other').toContain(' tail x.');
  });

  /** Repeated text of `length`, a struck character in the middle, highlighted whole. */
  const longRun = (length: number) => {
    const text = 'lorem ipsum dolor '.repeat(Math.ceil(length / 18)).slice(0, length - 1) + 'q';
    const at = text.indexOf('d', Math.floor(length / 2));
    const kept = text.slice(0, at) + text.slice(at + 1);
    const pane = suggesting(`Intro line stays.\n\n${text}\n\nClosing line stays too.\n`);
    try {
      pane.caret('lorem', at + 1);
      pane.press('Backspace');
      pane.caret('lorem', 0);
      pane.edit(() => ($getSelection() as RangeSelection).insertText('=='));
      pane.caret('==lorem', length + 2);
      pane.edit(() => ($getSelection() as RangeSelection).insertText('=='));
      pane.edit(() => $highlight(`==${text}==`));
      expect(pane.text(), 'F leaves the struck character out').toContain(`\n\n${kept}\n\n`);
    } finally {
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join('|'), 'the card adds the text without it').not.toContain(text);
    expect(working).not.toContain(text);
    expect(body, 'accept leaves it out').toContain(`==${kept}==`);
    expect(body).toContain('Closing line stays too.');
  };

  it('a run just past the old alignment limit keeps its interior strike', () => longRun(2_010));
  it('a run below it keeps its interior strike too', () => longRun(1_980));
});

// B303: a rebuild reads each deleted run once, and the trace carries only the spots of the node an operation changes.
describe('a rebuild costs linear work in the run and the strikes @p:mean-2 @p:R17', () => {
  const LENGTH = 600;
  /** Lower-case text with `strikes` capitals spread through it and an escape in the middle, so the rewrite is no slice of it. */
  const textWith = (strikes: number) => {
    const chars = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(LENGTH / 27)).slice(0, LENGTH).split('');
    const at: number[] = [];
    for (let i = 0; i < strikes; i += 1) {
      const where = 10 + Math.floor((i * (LENGTH - 20)) / strikes);
      chars[where] = 'Z';
      at.push(where);
    }
    chars[LENGTH / 2 + 3] = '\\';
    chars[LENGTH / 2 + 4] = '*';
    return { text: chars.join(''), at };
  };
  const rewrite = (strikes: number, elsewhere = 0) => {
    const { text, at } = textWith(strikes);
    const closing = elsewhere ? `closing ${'k'.repeat(elsewhere)} end` : 'closing line stays too.';
    const pane = suggesting(`intro line stays.\n\n${text.replace('\\*', '\\\\\\*')}\n\n${closing}\n`);
    let work = { units: 0, lookups: 0, spots: 0 };
    try {
      expect(pane.text(), 'the escape is in the text').toContain(text);
      for (const where of at) {
        pane.caret('lorem', where + 1);
        pane.press('Backspace');
      }
      if (elsewhere) {
        pane.caret('closing', 8, 8 + elsewhere);
        pane.press('Backspace');
      }
      rebuildWork.units = 0;
      rebuildWork.lookups = 0;
      traceWork.spots = 0;
      pane.caret('lorem', 0);
      pane.edit(() => ($getSelection() as RangeSelection).insertText('=='));
      pane.caret('==lorem', LENGTH + 2);
      pane.edit(() => ($getSelection() as RangeSelection).insertText('=='));
      pane.edit(() => $highlight(`==${text}==`, true));
      work = { units: rebuildWork.units, lookups: rebuildWork.lookups, spots: traceWork.spots };
      expect(pane.text(), 'F leaves every struck capital out').not.toMatch(/Z/);
      pane.undo();
      expect(pane.text(), 'undo: still out').not.toMatch(/Z/);
      pane.redo();
      expect(pane.text(), 'redo: still out').not.toMatch(/Z/);
    } finally {
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join('|'), 'the card adds no struck capital').not.toMatch(/Z/);
    expect(working).not.toMatch(/Z/);
    expect(body, 'accept leaves every struck capital out').not.toMatch(/Z/);
    expect(body, 'and keeps the rest').toContain('lorem ipsum');
    return work;
  };

  it('8 and then 16 struck characters in a 600-character paragraph: units read and lookups stay linear', () => {
    const one = rewrite(8);
    const two = rewrite(16);
    for (const [label, work] of [['8', one], ['16', two]] as const) {
      expect(work.units, `${label} strikes: each deleted run read once`).toBeLessThanOrEqual(2 * (LENGTH + 20));
      expect(work.lookups, `${label} strikes: a lookup per struck character`).toBeLessThanOrEqual(4 * 16);
    }
    expect(two.units, 'twice the strikes, no more units').toBeLessThanOrEqual(one.units + 40);
  });

  it("strikes in another paragraph add nothing to the trace's work on this one", () => {
    const alone = rewrite(8);
    const crowded = rewrite(8, 200);
    expect(crowded.spots, 'only the spots in the nodes each operation changes').toBeLessThanOrEqual(alone.spots + 20);
  });
});

// B302: struck text a rewrite took out of F is drawn struck where it stood, outside the editor's tree and the record.
describe('a struck character a rewrite removed stays visible and struck where it stood @p:mean-2 @p:R17', () => {
  it("strike 'b' of 'abc' and highlight: the author's DOM shows a struck 'b' after 'a', through undo and redo; the card, the working export and accept omit it", () => {
    const pane = suggesting(NOTE, { dom: true });
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const look = (label: string) => {
      const ghosts = pane.editor.getEditorState().read(() => ghostsOf(pane.fork, pane.binding));
      expect(ghosts.map((ghost) => ghost.text), `${label}: the struck "b" is shown`).toEqual(['b']);
      const [ghost] = ghosts;
      pane.editor.getEditorState().read(() => {
        const content = $getNodeByKey(ghost.place.key)!.getTextContent();
        const at = ghost.place.offset + (ghost.after ? 1 : 0);
        expect(content.slice(0, at), `${label}: just after "a"`).toMatch(/a$/);
        expect(content.slice(at), `${label}: just before "c"`).toMatch(/^c/);
      });
      drawGhosts(pane.editor, overlay, ghosts);
      const shown = [...overlay.querySelectorAll<HTMLElement>('[data-suggest-ghost]')];
      expect(shown.map((element) => element.textContent), `${label}: drawn struck`).toEqual(['b']);
      expect(shown[0].className).toContain('moss-suggest-ghost');
      expect(pane.editor.getRootElement()!.textContent, `${label}: never in the editor's own text`).not.toMatch(/a=*b/);
    };
    try {
      highlighted(pane);
      expect(pane.editor.getRootElement()!.textContent, 'the editor renders F').toContain('ac');
      look('the rewrite');
      pane.undo();
      look('undo');
      pane.redo();
      look('redo');
    } finally {
      overlay.remove();
      pane.dispose();
    }
    const { inserted, working, body } = reviewed(pane);
    expect(inserted.join('|'), 'the card omits the "b"').not.toContain('b');
    expect(working).not.toMatch(/a[\\=]*b/);
    expect(body).not.toMatch(/a[\\=]*b/);
    expect(body).toMatch(/a[\\=]*c/);
  });
});
