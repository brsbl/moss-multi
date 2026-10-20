// @vitest-environment jsdom
// T5.R2, T5.S10: in Suggest mode a paste is the ordinary Lexical paste, one editor update in the fork, never the large
// paste's batches (T3.S6). Before it is dispatched it is admitted against every suggestion cap, the deletion of a
// selection it replaces included, then lands with that strike as one undo step (one op, one record), or is refused
// whole with nothing changed (suggestions.md §5). Its undo and its redo are one step each.
import { $generateNodesFromSerializedNodes, $insertDataTransferForRichText, $insertGeneratedNodes } from '@lexical/clipboard';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestRequest } from '@moss-multi/protocol/suggest';
import { SUGGEST_LIMITS } from '@moss-multi/protocol/suggest';
import {
  $getRoot, $getSelection, $isRangeSelection, $setSelection, COMMAND_PRIORITY_EDITOR, DELETE_CHARACTER_COMMAND, INSERT_PARAGRAPH_COMMAND, PASTE_COMMAND, REDO_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { $createTableSelectionFrom, $isTableCellNode, $isTableNode, registerTablePlugin, type TableCellNode, type TableNode } from '@lexical/table';
import { mergeRegister } from '@lexical/utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { markdownToState } from '../../../../../../packages/sync/src/converter/index.ts';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { Composite, destroyView, GROUP_IDLE_MS, SuggestFork } from '../../../../../../packages/sync/src/suggest/client.ts';
import { payloadDocsFor, payloadText } from '../../../../../../packages/sync/src/payload-docs.ts';
import { REGISTER_LOCAL_ORIGIN } from '../../../../../../packages/sync/src/registers.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { closeRecord, openRecords, readMeta, readRecord } from '../../../../../../packages/sync/src/suggest/records.ts';
import { acceptRecord, EMPTY_IDLE_MS, nodeRegistry, previewRecord, reviewPreview } from '../../../../../../packages/sync/src/suggest/review.ts';
import { EDITOR, forgeRecord, opOn, seededBody, select, spansOfText, SUGGESTER, textNode } from '../../../../../../packages/sync/src/suggest/test-support.ts';
import { describePreview } from '../../../../../../packages/core/src/suggest/describe.ts';
import { positionAt, project } from '../../../../../../packages/core/src/tree-anchor.ts';
import { refusalMessage } from '../../refusal.ts';
import { publishBinding } from '../binding-registry.ts';
import { createBindingUndoManager } from '../undo.ts';
import { $pasteAt, measurePaste, stepBytes } from './paste.ts';
import { pendingInserts, struckByRecord } from './paint.ts';
import { registerSuggestRouting } from './routing.ts';

/** The payload bytes the DocDO last said it counts for a doc (doc-session.ts), withheld payloads included. */
const counted = new WeakMap<Y.Doc, number>();
vi.mock('../doc-session.ts', async (original) => ({
  ...(await original<typeof import('../doc-session.ts')>()),
  countedPayloadBytes: (doc: Y.Doc) => counted.get(doc) ?? 0,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

/**
 * The pane's paste, here and in the copy a Suggest-mode paste is measured on: markdown through moss's own import (a
 * chart fence becomes a chart), HTML or a Lexical clipboard as @lexical/clipboard inserts it (Lexical's rich paste),
 * plain text a paragraph per line break (CR, LF or CRLF, as the paste handler normalizes them).
 */
function pasteStack(target: LexicalEditor): () => void {
  // The table plugin, as the pane registers it: cells selected, or a table pasted in a cell, overwrite cells.
  return mergeRegister(registerTablePlugin(target), target.registerCommand(PASTE_COMMAND, (event) => {
    const data = (event as ClipboardEvent).clipboardData;
    if (!data) return false;
    const markdown = data.getData('text/markdown').replace(/\r\n?/g, '\n');
    const rich = data.getData('text/html') || data.getData('application/x-lexical-editor');
    const text = data.getData('text/plain').replace(/\r\n?/g, '\n');
    target.update(() => {
      const selection = $getSelection();
      if (!selection) return;
      // Cells selected: Lexical's rich paste, which the table plugin writes into the grid from the anchor cell.
      if (!$isRangeSelection(selection)) {
        $insertDataTransferForRichText(data, selection, target);
        return;
      }
      if (markdown) {
        $insertGeneratedNodes(target, $generateNodesFromSerializedNodes(markdownToState(markdown).root.children), selection);
        return;
      }
      if (rich) {
        $insertDataTransferForRichText(data, selection, target);
        return;
      }
      text.split('\n').forEach((line, i) => {
        const at = $getSelection();
        if (!$isRangeSelection(at)) return;
        if (i > 0) at.insertParagraph();
        const next = $getSelection();
        if (line && $isRangeSelection(next)) next.insertText(line);
      });
    });
    return true;
  }, COMMAND_PRIORITY_EDITOR));
}

/** A clipboard holding `text` as plain text, as a paste event carries it. */
const plainClipboard = (text: string) => ({
  types: ['text/plain'],
  getData: (type: string) => (type === 'text/plain' ? text : ''),
}) as unknown as DataTransfer;

/**
 * A suggester's pane on F: the body's undo, the routing, and Lexical's own plain-text paste (a paragraph per line, as
 * @lexical/rich-text's paste handler makes one, in one update); a reachable DocDO. `before` runs on the DocDO before
 * the fork asks for its leases.
 */
function suggesting(markdown = 'Intro line stays.\n\nClosing line stays too.\n', before?: (ingest: SuggestIngest) => void) {
  const live = seededBody(markdown);
  let n = 0;
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => `r${(n += 1)}` });
  before?.(ingest);
  const outbox: SuggestRequest[] = [];
  let requests = 0;
  /** Requests that change a suggestion: every kind but a lease. */
  let changes = 0;
  let clock = 1_000;
  const fork = new SuggestFork(live, {
    me: SUGGESTER.id, name: SUGGESTER.name, now: () => clock,
    send: (request) => {
      requests += 1;
      if (request.t !== 'suggest-lease') changes += 1;
      outbox.push(request);
    },
  });
  const bound = bindEditor(fork.doc);
  const { editor } = bound;
  // The pane's editor, unlike this headless one, takes root listeners; in jsdom it has no root element.
  Object.assign(editor, { registerRootListener: () => () => {}, getRootElement: () => null, getElementByKey: () => null });
  const undo = createBindingUndoManager(bound.binding);
  (editor as unknown as Record<symbol, unknown>)[Symbol.for('@lexical/yjs/UndoManager')] = undo;
  const stops = [
    publishBinding(editor, bound.binding),
    // The collaboration plugin's undo and redo, which the routing takes precedence over.
    editor.registerCommand(UNDO_COMMAND, () => {
      undo.undo();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    editor.registerCommand(REDO_COMMAND, () => {
      undo.redo();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    // Lexical's own Backspace, which the routing leaves his own text to.
    editor.registerCommand(DELETE_CHARACTER_COMMAND, (backward) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return true;
      // Headless, a caret's character is selected by offset (Lexical's own uses the DOM's selection.modify).
      const { anchor } = selection;
      if (selection.isCollapsed() && anchor.type === 'text') {
        const offset = backward ? anchor.offset - 1 : anchor.offset + 1;
        if (offset < 0 || offset > anchor.getNode().getTextContentSize()) return true;
        selection.focus.set(anchor.key, offset, 'text');
      }
      selection.removeText();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    // Lexical's own Enter, after the routing's.
    editor.registerCommand(INSERT_PARAGRAPH_COMMAND, () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertParagraph();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    pasteStack(editor),
    registerSuggestRouting(editor, fork, { pasteStack: () => pasteStack }),
  ];
  const unsaved: string[] = [];
  fork.on((event) => {
    if (event.type === 'refused') unsaved.push(...event.unsaved);
  });
  fork.begin();
  const who = { ...SUGGESTER, role: 'suggester', connection: 'paste' };
  /** The DocDO answers every request sent so far, in order. */
  const pump = () => {
    while (outbox.length) fork.receive(handleSuggest(ingest, who, outbox.shift()!));
  };
  pump();
  editor.update(() => $getRoot().getLastChildOrThrow().selectEnd(), { discrete: true });
  /** A real paste command of `lines`, as plain text, committed at once (the browser commits it in a microtask). */
  const pasteData = (clipboardData: DataTransfer) => editor.update(() => {
    editor.dispatchCommand(PASTE_COMMAND, { clipboardData, preventDefault: () => {}, stopPropagation: () => {} } as unknown as ClipboardEvent);
  }, { discrete: true });
  const paste = (lines: string[]) => pasteData(plainClipboard(lines.join('\n')));
  return {
    fork,
    live,
    ingest,
    editor,
    unsaved,
    paste,
    pasteData,
    /** Typing `text` at the caret, one keystroke's update. */
    type: (text: string) => editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    }, { discrete: true }),
    pump,
    /** Requests of any kind sent so far. */
    requests: () => requests,
    changes: () => changes,
    /** The fork's clock moves on `ms`. */
    idle: (ms: number) => {
      clock += ms;
    },
    select: (prefix: string, anchor: number, focus: number) => editor.update(() => {
      select(prefix, anchor, focus);
    }, { discrete: true }),
    selected: () => editor.getEditorState().read(() => $getSelection()?.getTextContent() ?? ''),
    /** Characters struck by the author's open delete parts. */
    struck: () => fork.struck().reduce((sum, span) => sum + span.len, 0),
    undo: () => editor.update(() => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    }, { discrete: true }),
    redo: () => editor.update(() => {
      editor.dispatchCommand(REDO_COMMAND, undefined);
    }, { discrete: true }),
    /** Enter, one keystroke's update. */
    enter: () => editor.update(() => {
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    }, { discrete: true }),
    /** Backspace, one keystroke's update. */
    backspace: () => editor.update(() => {
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    }, { discrete: true }),
    /** The next edit starts a new undo step, as after the capture interval. */
    stopCapturing: () => undo.stopCapturing(),
    text: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
    dispose: () => {
      for (const stop of stops) stop();
      undo.destroy();
      bound.dispose();
      fork.dispose();
    },
  };
}

/** Bytes of ops record `id` holds. */
const recordBytes = (pane: ReturnType<typeof suggesting>, id: string) => readRecord(pane.live, id)!.ops.reduce((sum, op) => sum + op.update.byteLength, 0);

/** Runs timers until the refusal notice shows (it clears itself on a timer), then the rest. */
function noticed(): string {
  while (!refusalMessage() && vi.getTimerCount() > 0) vi.advanceTimersToNextTimer();
  const message = refusalMessage();
  vi.runAllTimers();
  return message;
}

/**
 * A paste is never admitted and then dropped (suggestions.md §5, PRODUCT line 34): either it lands as one op the DocDO
 * stores and acknowledges, or it is refused whole, visibly, with nothing sent or changed and the selection kept.
 */
function storedOrRefused(pane: ReturnType<typeof suggesting>, paste: () => void): 'stored' | 'refused' {
  const text = pane.text();
  const selected = pane.selected();
  const before = pane.requests();
  const sent = pane.fork.sent;
  paste();
  const notice = refusalMessage();
  if (notice) {
    expect(notice, 'refused visibly').toMatch(/suggest/i);
    expect(pane.requests(), 'nothing was sent, no strike either').toBe(before);
    expect(pane.fork.struck(), 'nothing is struck').toEqual([]);
    expect(pane.text(), 'F is unchanged').toBe(text);
    expect(pane.selected(), 'the selection is kept').toBe(selected);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'input stays open').toBe(false);
    return 'refused';
  }
  vi.runAllTimers();
  // One op in the body, and one in each payload doc it writes (a chart's).
  expect(pane.fork.sent - sent, 'the paste was sent').toBeGreaterThan(0);
  pane.pump();
  expect(pane.fork.closed, 'the DocDO stores the paste').toBe(false);
  expect(pane.unsaved, 'nothing offered back').toEqual([]);
  return 'stored';
}

/** Whether a fresh pane admits a paste of `line` at its last paragraph's end: the paste fits every cap alone. */
function admittedAlone(line: string): boolean {
  const pane = suggesting();
  try {
    pane.paste([line]);
    const notice = refusalMessage();
    vi.runAllTimers();
    pane.pump();
    return !notice && !pane.fork.closed && openRecords(pane.live, SUGGESTER.id).length === 1;
  } finally {
    pane.dispose();
  }
}

it('an admissible large paste lands in one op as one record, and its undo and its redo are one op each', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    // Many batches' worth in Edit mode (a paragraph is some 300 bytes of ops), under the record cap with its redo.
    const lines = Array.from({ length: 150 }, (_, i) => `para <${i}>`);
    const before = pane.fork.sent;
    pane.paste(lines);
    vi.runAllTimers();
    expect(pane.fork.sent - before, 'the paste is one op').toBe(1);
    pane.pump();
    expect(pane.fork.closed, 'admitted').toBe(false);
    const records = openRecords(pane.live, SUGGESTER.id);
    expect(records.map((record) => record.ops.length), 'one record holds it').toEqual([1]);
    expect(pane.text()).toContain('para <0>');
    expect(pane.text()).toContain('para <149>');

    pane.undo();
    vi.runAllTimers();
    expect(pane.fork.sent - before, 'one undo, one op').toBe(2);
    expect(pane.text(), 'one undo takes all of it back').not.toMatch(/para <\d+>/);
    pane.pump();
    pane.redo();
    vi.runAllTimers();
    expect(pane.fork.sent - before, 'one redo, one op').toBe(3);
    expect(pane.text(), 'one redo brings all of it back').toContain('para <0>');
    expect(pane.text()).toContain('para <149>');
    pane.pump();
    expect(pane.fork.closed, 'nothing refused').toBe(false);
  } finally {
    pane.dispose();
  }
});

it('a refusal of the paste offers back every pasted paragraph', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const lines = Array.from({ length: 150 }, (_, i) => `para <${i}>`);
    pane.paste(lines);
    vi.runAllTimers();
    // The DocDO refuses it (record-cap, ops-cap: any reason).
    pane.fork.receive({ t: 'suggest-refused', record: pane.fork.record, reason: 'record-cap' });
    vi.runAllTimers();
    const offered = pane.unsaved.join('\n');
    const lost = lines.filter((line) => !offered.includes(line));
    expect(lost.length, `paragraphs neither saved nor offered back, e.g. ${lost.slice(0, 3).join(', ')}`).toBe(0);
  } finally {
    pane.dispose();
  }
});

it('a paste past the suggestion record cap is refused whole, before any of it reaches F', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    // About 400 KB of text: past the 256 KiB of ops one suggestion holds, far under the note's cap.
    const lines = Array.from({ length: 10_000 }, (_, i) => `para <${i}> ${'x'.repeat(28)}`);
    const text = pane.text();
    const before = pane.requests();
    pane.paste(lines);
    expect(noticed(), 'refused visibly').toMatch(/suggest/i);
    expect(pane.requests(), 'nothing was sent').toBe(before);
    expect(pane.text(), 'F is unchanged').toBe(text);
    expect(pane.fork.closed, 'input stays open').toBe(false);
  } finally {
    pane.dispose();
  }
});

it('a paste over a selection past the record cap is refused whole: nothing struck, nothing sent, the selection kept', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    pane.select('Intro line', 6, 10);
    expect(pane.selected()).toBe('line');
    const lines = Array.from({ length: 10_000 }, (_, i) => `para <${i}> ${'x'.repeat(28)}`);
    const text = pane.text();
    const before = pane.requests();
    pane.paste(lines);
    expect(noticed(), 'refused visibly').toMatch(/suggest/i);
    expect(pane.requests(), 'nothing was sent, no strike either').toBe(before);
    expect(pane.fork.struck(), 'nothing is struck').toEqual([]);
    expect(pane.text(), 'F is unchanged').toBe(text);
    expect(pane.selected(), 'the selection is kept').toBe('line');
    expect(pane.fork.closed, 'input stays open').toBe(false);
  } finally {
    pane.dispose();
  }
});

it('an admissible paste over a selection strikes it and lands, as one suggestion', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    pane.select('Intro line', 6, 10);
    const lines = Array.from({ length: 150 }, (_, i) => `para <${i}>`);
    pane.paste(lines);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'admitted').toBe(false);
    expect(pane.struck(), 'the selection is struck').toBe(4);
    expect(pane.text()).toContain('para <0>');
    expect(pane.text()).toContain('para <149>');
    expect(openRecords(pane.live, SUGGESTER.id), 'one record holds the strike and the paste').toHaveLength(1);
  } finally {
    pane.dispose();
  }
});

it('a paste that would take the open record it extends past the record cap is refused whole', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const cap = SUGGEST_LIMITS.recordOpsBytes;
    // The first paste lands as one record, well under the cap: one line, so the caret stays in the block it was
    // pasted into and the next edit continues the same group (a caret moved away starts a record of its own).
    pane.paste([`first ${'x'.repeat(90_000)}`]);
    vi.runAllTimers();
    pane.pump();
    const record = pane.fork.record!;
    const held = recordBytes(pane, record);
    expect(held, 'the first paste landed, a fair share of the cap').toBeGreaterThan(cap * 0.3);
    expect(held, 'under half the cap').toBeLessThan(cap * 0.5);
    // The second, at the same caret, fits every cap alone (a fresh pane admits it), not with what the record holds.
    const second = [`second ${'x'.repeat(100_000)}`];
    expect(admittedAlone(second[0]), 'the second paste alone fits').toBe(true);
    const text = pane.text();
    const before = pane.requests();
    pane.paste(second);
    expect(noticed(), 'refused visibly').toMatch(/suggest/i);
    expect(pane.requests(), 'nothing was sent').toBe(before);
    expect(pane.text(), 'F is unchanged').toBe(text);
    pane.pump();
    expect(pane.fork.closed, 'input stays open').toBe(false);
    expect(recordBytes(pane, record), 'the record holds the first paste only').toBe(held);
  } finally {
    pane.dispose();
  }
});

it('a refusal of the redo of a paste offers back every redone paragraph', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const lines = Array.from({ length: 150 }, (_, i) => `para <${i}>`);
    pane.paste(lines);
    vi.runAllTimers();
    pane.pump();
    pane.undo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.text(), 'undone').not.toContain('para <0>');
    const before = pane.fork.sent;
    pane.redo();
    vi.runAllTimers();
    expect(pane.fork.sent, 'the redo reached the DocDO').toBeGreaterThan(before);
    // The DocDO refuses it (doc-cap, open-cap, the record closing: any reason).
    pane.fork.receive({ t: 'suggest-refused', record: pane.fork.record, reason: 'doc-cap' });
    vi.runAllTimers();
    const offered = pane.unsaved.join('\n');
    const lost = lines.filter((line) => !offered.includes(line));
    expect(lost.length, `paragraphs neither saved nor offered back, e.g. ${lost.slice(0, 3).join(', ')}`).toBe(0);
  } finally {
    pane.dispose();
  }
});

it('a paste that builds on an older open record after its group rotated counts that record, which it would merge: past the cap it is refused whole', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const cap = SUGGEST_LIMITS.recordOpsBytes;
    pane.paste([`first ${'x'.repeat(90_000)}`]);
    vi.runAllTimers();
    pane.pump();
    const record = pane.fork.record!;
    const held = recordBytes(pane, record);
    expect(held, 'the first paste landed, a fair share of the cap').toBeGreaterThan(cap * 0.3);
    // Past the idle gap the next edit starts a new group, under the spare lease; at the same caret it builds on the
    // first paste's items, so its record merges the first one (client.ts #forward). Alone the second paste fits every
    // cap (a fresh pane admits it); merged with the first it does not.
    pane.idle(GROUP_IDLE_MS + 1_000);
    const second = `second ${'x'.repeat(100_000)}`;
    expect(admittedAlone(second), 'the second paste alone fits').toBe(true);
    const text = pane.text();
    const before = pane.changes();
    pane.paste([second]);
    expect(noticed(), 'refused visibly').toMatch(/suggest/i);
    // The new group may ask for its next spare lease; nothing it sends changes a suggestion.
    expect(pane.changes(), 'nothing was sent, no merge either').toBe(before);
    expect(pane.text(), 'F is unchanged').toBe(text);
    pane.pump();
    expect(pane.fork.closed, 'input stays open').toBe(false);
    expect(openRecords(pane.live, SUGGESTER.id).map((open) => open.meta.id), 'the first record alone').toEqual([record]);
    expect(recordBytes(pane, record), 'it holds the first paste only').toBe(held);
  } finally {
    pane.dispose();
  }
});

it('an admissible paste that builds on an older open record after its group rotated lands, merged into one suggestion', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    pane.paste([`first ${'x'.repeat(50_000)}`]);
    vi.runAllTimers();
    pane.pump();
    pane.idle(GROUP_IDLE_MS + 1_000);
    pane.paste([`second ${'y'.repeat(50_000)}`]);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'admitted, and the merge too').toBe(false);
    expect(openRecords(pane.live, SUGGESTER.id), 'one suggestion holds both').toHaveLength(1);
    expect(pane.text()).toContain('second yyy');
  } finally {
    pane.dispose();
  }
});

it('a paste over a selection of another author\'s text strikes it and lands in one step: one undo takes both back, one redo brings both back', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    pane.select('Intro line', 6, 10);
    const lines = Array.from({ length: 150 }, (_, i) => `para <${i}>`);
    pane.paste(lines);
    vi.runAllTimers();
    pane.pump();
    expect(pane.struck(), 'the selection is struck').toBe(4);
    expect(pane.text()).toContain('para <149>');

    pane.undo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.text(), 'one undo takes the paste back').not.toMatch(/para <\d+>/);
    expect(pane.struck(), 'and the strike').toBe(0);

    pane.redo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.text(), 'one redo brings the paste back').toContain('para <149>');
    expect(pane.struck(), 'and the strike').toBe(4);
    expect(pane.fork.closed, 'nothing refused').toBe(false);
  } finally {
    pane.dispose();
  }
});

it('a paste inside a long paragraph counts the paragraph\'s rest, which the split re-creates under the suggester: past the cap with it, refused whole', { timeout: 120_000 }, () => {
  const pane = suggesting(`Ada ${'q'.repeat(150_000)}\n\nSecond line.\n`);
  try {
    pane.select('Ada', 0, 3);
    expect(pane.selected()).toBe('Ada');
    const text = pane.text();
    const before = pane.requests();
    // About 120 KB: under the record cap alone, past it with the 150 KB of the paragraph's rest the split re-creates.
    pane.paste([`One ${'a'.repeat(60_000)}`, `Two ${'b'.repeat(60_000)}`]);
    expect(noticed(), 'refused visibly').toMatch(/suggest/i);
    expect(pane.requests(), 'nothing was sent, no strike either').toBe(before);
    expect(pane.fork.struck(), 'nothing is struck').toEqual([]);
    expect(pane.text(), 'F is unchanged').toBe(text);
    expect(pane.selected(), 'the selection is kept').toBe('Ada');
    pane.pump();
    expect(pane.fork.closed, 'input stays open').toBe(false);
    expect(openRecords(pane.live, SUGGESTER.id), 'no suggestion was made').toEqual([]);
  } finally {
    pane.dispose();
  }
});

it('a paste inside a 150 KB paragraph either lands as one suggestion whose undo and redo are one step each, or is refused whole with nothing changed', { timeout: 120_000 }, () => {
  const pane = suggesting(`Lead words MID ${'q'.repeat(150_000)}\n\nSecond line.\n`);
  try {
    pane.select('Lead words', 11, 14);
    expect(pane.selected()).toBe('MID');
    const text = pane.text();
    const before = pane.requests();
    pane.paste([`Alpha ${'c'.repeat(20_000)}`, `Beta ${'d'.repeat(20_000)}`]);
    const notice = refusalMessage();
    if (notice) {
      expect(notice, 'refused visibly').toMatch(/suggest/i);
      expect(pane.requests(), 'nothing was sent, no strike either').toBe(before);
      expect(pane.fork.struck(), 'nothing is struck').toEqual([]);
      expect(pane.text(), 'F is unchanged').toBe(text);
      expect(pane.selected(), 'the selection is kept').toBe('MID');
      vi.runAllTimers();
      pane.pump();
      expect(pane.fork.closed, 'input stays open').toBe(false);
      expect(openRecords(pane.live, SUGGESTER.id), 'no suggestion was made').toEqual([]);
      return;
    }
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the paste is stored').toBe(false);
    expect(pane.struck(), 'the selection is struck').toBe(3);
    expect(pane.text()).toContain('Beta ddd');
    const sent = pane.fork.sent;

    pane.undo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the undo is stored').toBe(false);
    expect(pane.fork.sent - sent, 'one undo, one op').toBe(1);
    expect(pane.text(), 'one undo takes the paste back').toBe(text);
    expect(pane.struck(), 'and the strike').toBe(0);

    pane.redo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the redo is stored').toBe(false);
    expect(pane.fork.sent - sent, 'one redo, one op').toBe(2);
    expect(pane.text(), 'one redo brings the paste back').toContain('Beta ddd');
    expect(pane.struck(), 'and the strike').toBe(3);
  } finally {
    pane.dispose();
  }
});

it('when the active lease names an accepted record, a paste opens its continuation and counts the open-suggestion cap: past it, refused before anything changes', { timeout: 120_000 }, () => {
  // Another window of the author holds three unused leases: this fork gets one lease and no spare.
  const window = { ...SUGGESTER, role: 'suggester', connection: 'other-window' };
  const pane = suggesting(undefined, (ingest) => {
    expect(ingest.lease(window, [], 2).ok).toBe(true);
    expect(ingest.lease(window, [], 1).ok).toBe(true);
  });
  try {
    pane.paste(['hello']);
    vi.runAllTimers();
    pane.pump();
    const accepted = pane.fork.record!;
    expect(readRecord(pane.live, accepted), 'the paste made a record').not.toBeNull();
    // An editor accepts the fork's record: its next frame opens a continuation, a new open record.
    closeRecord(pane.live, accepted, { status: 'accepted', resolvedBy: EDITOR.id, resolvedAt: 1 });
    vi.runAllTimers();
    pane.pump();
    // The author's other windows hold as many open suggestions as one author may.
    for (let i = 0; i < SUGGEST_LIMITS.openPerPrincipal; i += 1) {
      const who = { ...SUGGESTER, role: 'suggester', connection: `w-${i}` };
      const grant = pane.ingest.lease(who, [], 1);
      if (!grant.ok) throw new Error(`no lease: ${grant.reason}`);
      expect(pane.ingest.delete(who, grant.leases[0].record, { id: `d${i}`, targets: spansOfText(pane.live, 'Intro') })).toMatchObject({ ok: true });
      pane.ingest.expireConnection(`w-${i}`);
    }
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.record, 'no spare lease to rotate to').toBe(accepted);
    expect(openRecords(pane.live, SUGGESTER.id), 'the author is at the cap').toHaveLength(SUGGEST_LIMITS.openPerPrincipal);
    const text = pane.text();
    const before = pane.changes();
    pane.paste(['world']);
    expect(noticed(), 'refused visibly').toMatch(/too many open suggestions/i);
    expect(pane.changes(), 'nothing was sent').toBe(before);
    expect(pane.text(), 'F is unchanged').toBe(text);
    pane.pump();
    expect(pane.fork.closed, 'input stays open').toBe(false);
  } finally {
    pane.dispose();
  }
});

it('a paste that fits the note beside the payloads the fork holds, but not beside those the DocDO counts for the body, is refused whole', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    // The DocDO counts withheld payloads (a deleted code block's text) against the note's cap; the body's session
    // knows their bytes from its acks, the fork does not hold them.
    counted.set(pane.live, STATE_CAP_BYTES - 20_000);
    pane.select('Intro line', 6, 10);
    const text = pane.text();
    const before = pane.requests();
    pane.paste(Array.from({ length: 150 }, (_, i) => `para <${i}>`));
    expect(noticed(), 'refused visibly').not.toBe('');
    expect(pane.requests(), 'nothing was sent, no strike either').toBe(before);
    expect(pane.fork.struck(), 'nothing is struck').toEqual([]);
    expect(pane.text(), 'F is unchanged').toBe(text);
    expect(pane.selected(), 'the selection is kept').toBe('line');
  } finally {
    pane.dispose();
  }
});

it('an admitted paste near the record cap at a paragraph end is stored with its one undo and its one redo, or refused whole', { timeout: 120_000 }, () => {
  // A record's ops only grow: the redo re-creates the paste under new clocks, beside the paste's own op.
  let landed = 0;
  for (const size of [140_000, 90_000]) {
    const pane = suggesting('Ada original line.\n\nSecond line.\n');
    try {
      const text = pane.text();
      const before = pane.requests();
      pane.paste([`Tail ${'f'.repeat(size)}`]);
      const notice = refusalMessage();
      if (notice) {
        expect(notice, `${size}: refused visibly`).toMatch(/suggest/i);
        expect(pane.requests(), `${size}: nothing was sent`).toBe(before);
        expect(pane.text(), `${size}: F is unchanged`).toBe(text);
        vi.runAllTimers();
        pane.pump();
        expect(pane.fork.closed, `${size}: input stays open`).toBe(false);
        continue;
      }
      vi.runAllTimers();
      pane.pump();
      expect(pane.fork.closed, `${size}: the paste is stored`).toBe(false);
      const sent = pane.fork.sent;
      pane.undo();
      vi.runAllTimers();
      pane.pump();
      expect(pane.fork.closed, `${size}: the undo is stored`).toBe(false);
      expect(pane.fork.sent - sent, `${size}: one undo, one op`).toBe(1);
      expect(pane.text(), `${size}: one undo takes the paste back`).toBe(text);
      pane.redo();
      vi.runAllTimers();
      pane.pump();
      expect(pane.fork.closed, `${size}: the redo is stored`).toBe(false);
      expect(pane.fork.sent - sent, `${size}: one redo, one op`).toBe(2);
      expect(pane.text(), `${size}: one redo brings the paste back`).toContain('Tail fff');
      landed += 1;
    } finally {
      pane.dispose();
    }
  }
  expect(landed, 'a paste well under the cap is admitted').toBeGreaterThan(0);
});

it('a rich paste whose kept attributes may take it past the record cap is measured with them: stored whole or refused whole, never dropped', { timeout: 120_000 }, () => {
  const pane = suggesting('Ada original line.\n\nSecond line.\n');
  try {
    // A link's href and title become its node's properties in the fork: about 100 KB here, besides 15 KB of text.
    const plain = 'k'.repeat(15_000);
    const html = `<p><a href="https://example.invalid/" title="${'T'.repeat(100_000)}">${plain}</a></p>`;
    const clipboard = {
      types: ['text/html', 'text/plain'],
      getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? plain : ''),
    } as unknown as DataTransfer;
    storedOrRefused(pane, () => pane.pasteData(clipboard));
  } finally {
    pane.dispose();
  }
});

it('a paste at a collapsed caret is its own undo step: typing just before or after it is not taken back with it', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    pane.type('Z');
    pane.paste(['pasted words']);
    vi.runAllTimers();
    pane.type('Y');
    vi.runAllTimers();
    pane.pump();
    expect(pane.text()).toContain('Zpasted wordsY');
    pane.undo();
    vi.runAllTimers();
    expect(pane.text(), 'the first undo takes the typing after the paste').toContain('Zpasted words');
    expect(pane.text()).not.toContain('Y');
    pane.undo();
    vi.runAllTimers();
    expect(pane.text(), 'the second undo takes the paste, not the typing before it').toContain('Z');
    expect(pane.text()).not.toContain('pasted words');
  } finally {
    pane.dispose();
  }
});

it('a paste over only the suggester\'s own text is its own undo step: typing just before or after it is not taken back with it', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    pane.type(' mine');
    pane.select('Closing line', 24, 28);
    expect(pane.selected(), 'only his own text is selected').toBe('mine');
    pane.paste(['pasted']);
    vi.runAllTimers();
    pane.type('Y');
    vi.runAllTimers();
    pane.pump();
    expect(pane.text()).toContain('too. pastedY');
    pane.undo();
    vi.runAllTimers();
    expect(pane.text(), 'the first undo takes the typing after the paste').toContain('too. pasted');
    expect(pane.text()).not.toContain('Y');
    pane.undo();
    vi.runAllTimers();
    expect(pane.text(), 'the second undo takes the paste back, not the typing before it').toContain('too. mine');
    expect(pane.text()).not.toContain('pasted');
  } finally {
    pane.dispose();
  }
});

it('a short paste replacing the suggester\'s own large suggestion counts what its undo restores: refused whole, or its undo is stored in one step', { timeout: 120_000 }, () => {
  const pane = suggesting('Ada original line.\n\nSecond line.\n');
  try {
    // One suggestion of some 140 KB, in two admitted pastes at the same caret.
    pane.paste([`Tail ${'f'.repeat(90_000)}`]);
    vi.runAllTimers();
    pane.pump();
    pane.paste([`More ${'g'.repeat(50_000)}`]);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'both pastes are stored').toBe(false);
    expect(openRecords(pane.live, SUGGESTER.id), 'as one suggestion').toHaveLength(1);
    // Lexical's paste removes his own selected text natively; its undo restores it as new copies in the record.
    pane.select('Second line.', 12, 12 + 5 + 90_000 + 5 + 50_000);
    expect(pane.selected()).toMatch(/^Tail f+More g+$/);
    const text = pane.text();
    const before = pane.requests();
    pane.paste(['x']);
    const notice = refusalMessage();
    if (notice) {
      expect(notice, 'refused visibly').toMatch(/suggest/i);
      expect(pane.requests(), 'nothing was sent').toBe(before);
      expect(pane.text(), 'F is unchanged').toBe(text);
      expect(pane.selected(), 'the selection is kept').toMatch(/^Tail f+More g+$/);
      vi.runAllTimers();
      pane.pump();
      expect(pane.fork.closed, 'input stays open').toBe(false);
      return;
    }
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the paste is stored').toBe(false);
    const sent = pane.fork.sent;
    pane.undo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the undo is stored').toBe(false);
    expect(pane.fork.sent - sent, 'one undo, one op').toBe(1);
    expect(pane.text(), 'one undo takes the paste back').toBe(text);
  } finally {
    pane.dispose();
  }
});

it('every further undo and redo of a near-cap paste is admitted before it changes anything: stored, or refused with the note and the history unchanged', { timeout: 120_000 }, () => {
  const pane = suggesting('Ada original line.\n\nSecond line.\n');
  try {
    pane.paste([`Tail ${'f'.repeat(90_000)}`]);
    expect(refusalMessage(), 'the paste is admitted').toBe('');
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the paste is stored').toBe(false);
    // A record's ops only grow: each redo re-creates the paste beside the ops it already holds.
    let refused = '';
    for (let cycle = 1; cycle <= 3 && !refused; cycle += 1) {
      for (const action of ['undo', 'redo'] as const) {
        const text = pane.text();
        const before = pane.changes();
        const sent = pane.fork.sent;
        pane[action]();
        refused = refusalMessage();
        if (refused) {
          expect(refused, `${cycle} ${action}: refused visibly`).toMatch(/suggestion/i);
          expect(pane.changes(), `${cycle} ${action}: nothing was sent`).toBe(before);
          expect(pane.text(), `${cycle} ${action}: F is unchanged`).toBe(text);
          vi.runAllTimers();
          pane.pump();
          expect(pane.fork.closed, `${cycle} ${action}: input stays open`).toBe(false);
          // The history is kept: the same step is refused again, still with nothing changed.
          pane[action]();
          expect(refusalMessage(), `${cycle} ${action}: refused again`).toBe(refused);
          expect(pane.text(), `${cycle} ${action}: F is still unchanged`).toBe(text);
          vi.runAllTimers();
          break;
        }
        vi.runAllTimers();
        pane.pump();
        expect(pane.fork.closed, `${cycle} ${action}: stored`).toBe(false);
        expect(pane.fork.sent - sent, `${cycle} ${action}: one op`).toBe(1);
      }
    }
    expect(refused, 'a redo past the record cap is refused, not stored').not.toBe('');
  } finally {
    pane.dispose();
  }
});

it('an undo of a payload edit that builds on an older payload-only record counts that record, which it would merge: past the cap it is refused with the history kept', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const cap = SUGGEST_LIMITS.recordOpsBytes;
    // An older record of the author's that holds only a payload field's text: none of its items is in the body.
    const payload = payloadDocsFor(pane.fork.doc).hold('p-older', true);
    payload.transact(() => payloadText(payload).insert(0, 'z'.repeat(200_000)), REGISTER_LOCAL_ORIGIN);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the payload edit is stored').toBe(false);
    const older = pane.fork.record!;
    expect(recordBytes(pane, older), 'a large share of the cap').toBeGreaterThan(cap * 0.7);
    // Past the idle gap the next edit starts a new group, under the spare lease: a paste in a record of its own.
    pane.idle(GROUP_IDLE_MS + 1_000);
    pane.paste([`second ${'y'.repeat(50_000)}`]);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the paste is stored').toBe(false);
    expect(pane.fork.record, 'in a record of its own').not.toBe(older);
    pane.undo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the paste\'s undo is stored').toBe(false);
    expect(payloadText(payload).length, 'the first undo takes back the paste only').toBe(200_000);
    // The next undo deletes the older record's payload text under the active record, which merges it (#forward):
    // together they pass the record cap, so it is refused before anything changes.
    const before = pane.changes();
    pane.undo();
    const notice = refusalMessage();
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'nothing the DocDO refuses').toBe(false);
    expect(notice, 'refused visibly').toMatch(/suggestion/i);
    expect(pane.changes(), 'nothing was sent, no merge either').toBe(before);
    expect(payloadText(payload).length, 'the payload text is unchanged').toBe(200_000);
    expect(readRecord(pane.live, older)?.meta.status, 'the older record stays open').toBe('open');
  } finally {
    pane.dispose();
  }
});

/**
 * A pane whose note retains suggestion state (closed records, their tombstones, stored leases) up to `room` bytes
 * short of its share; a stored lease of another principal stands in for it. The note's own state stays far under its cap.
 */
function nearStateShare(room: number) {
  return suggesting(undefined, (ingest) => {
    const share = STATE_CAP_BYTES * SUGGEST_LIMITS.stateShare;
    // A stored lease is charged 128 bytes plus its clocks' JSON, {"<key>":1}.
    const key = 'p'.repeat(Math.floor(share - room - ingest.retainedBytes - 128 - 6));
    ingest.leases.put({
      client: 7, principal: 'someone-else', connection: 'gone', reserved: 'r-other', record: null, clocks: { [key]: 1 },
      spent: false, expired: true, usedAt: 0, fork: null,
    });
    ingest.remeasure();
    expect(Math.abs(share - ingest.retainedBytes - room), 'the room left under the share').toBeLessThan(8);
  });
}

it('a paste past the room left under the share of retained suggestion state is refused whole before anything changes', { timeout: 120_000 }, () => {
  const pane = nearStateShare(60_000);
  try {
    pane.select('Intro line', 6, 10);
    const text = pane.text();
    const before = pane.requests();
    // Some 70 KB: under the record cap with its redo, the open ops' share and the note's reserve; past the room.
    pane.paste([`big ${'x'.repeat(70_000)}`]);
    expect(noticed(), 'refused visibly').not.toBe('');
    expect(pane.requests(), 'nothing was sent, no strike either').toBe(before);
    expect(pane.fork.struck(), 'nothing is struck').toEqual([]);
    expect(pane.text(), 'F is unchanged').toBe(text);
    expect(pane.selected(), 'the selection is kept').toBe('line');
    pane.pump();
    expect(pane.fork.closed, 'input stays open').toBe(false);
    // A paste that fits the room lands.
    pane.paste(['small words']);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the small paste is stored').toBe(false);
    expect(pane.text()).toContain('small words');
  } finally {
    pane.dispose();
  }
});

it('every undo and redo of a paste is admitted against the room left under the share of retained suggestion state: stored, or refused with the history unchanged', { timeout: 120_000 }, () => {
  const pane = nearStateShare(45_000);
  try {
    pane.paste([`Tail ${'f'.repeat(10_000)}`]);
    expect(refusalMessage(), 'the paste is admitted').toBe('');
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the paste is stored').toBe(false);
    // Each redo re-creates the paste: retained state grows by it, far under the record cap.
    let refused = '';
    for (let cycle = 1; cycle <= 6 && !refused; cycle += 1) {
      for (const action of ['undo', 'redo'] as const) {
        const text = pane.text();
        const before = pane.changes();
        pane[action]();
        refused = refusalMessage();
        if (refused) {
          expect(pane.changes(), `${cycle} ${action}: nothing was sent`).toBe(before);
          expect(pane.text(), `${cycle} ${action}: F is unchanged`).toBe(text);
          vi.runAllTimers();
          pane.pump();
          expect(pane.fork.closed, `${cycle} ${action}: input stays open`).toBe(false);
          break;
        }
        vi.runAllTimers();
        pane.pump();
        expect(pane.fork.closed, `${cycle} ${action}: stored`).toBe(false);
      }
    }
    expect(refused, 'a redo past the room is refused, not stored').not.toBe('');
  } finally {
    pane.dispose();
  }
});

it('a paste that would merge an older open record counts the copy the merge adds to the note against its reserve: past it, refused whole before anything changes', { timeout: 120_000 }, () => {
  // The note's state as the DocDO counts it (persistence.ts): every update appended since the pane opened, plus `base`.
  let base = 0;
  let appended = 0;
  const pane = suggesting(undefined, (ingest) => {
    ingest.doc.on('update', (update: Uint8Array) => {
      appended += update.byteLength;
    });
    ingest.options.stateBytes = () => base + appended;
  });
  try {
    pane.paste([`first ${'x'.repeat(40_000)}`]);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the first paste is stored').toBe(false);
    const record = pane.fork.record!;
    // Other edits take the note to some 20 KB short of its reserve, less than the first record holds; a keystroke's
    // ack tells the fork.
    base = STATE_CAP_BYTES * SUGGEST_LIMITS.reserveShare - appended - 20_000;
    pane.type('!');
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the keystroke is stored').toBe(false);
    expect(recordBytes(pane, record), 'the merge would copy more than the reserve has left').toBeGreaterThan(20_000);
    // Past the idle gap a small paste at the same caret builds on the first record, which its record merges: the
    // merge copies the first record's ops into the note, past its reserve.
    pane.idle(GROUP_IDLE_MS + 1_000);
    const text = pane.text();
    const before = pane.changes();
    pane.paste(['small words']);
    expect(noticed(), 'refused visibly').not.toBe('');
    expect(pane.changes(), 'nothing was sent, no merge either').toBe(before);
    expect(pane.text(), 'F is unchanged').toBe(text);
    pane.pump();
    expect(pane.fork.closed, 'input stays open').toBe(false);
    expect(openRecords(pane.live, SUGGESTER.id).map((open) => open.meta.id), 'the first record alone').toEqual([record]);
  } finally {
    pane.dispose();
  }
});

it('an undo sizes the step the replay runs: a step whose items were created and deleted in one capture changes nothing, so the step under it counts', () => {
  const doc = new Y.Doc();
  const text = doc.getText('t');
  const manager = new Y.UndoManager(text, { captureTimeout: 60_000 });
  text.insert(0, 'a'.repeat(50_000));
  manager.stopCapturing();
  text.delete(0, 50_000);
  manager.stopCapturing();
  text.insert(0, 'x');
  text.delete(0, 1);
  const steps = manager.undoStack.map((item) => ({ entries: [{ manager, item }] }));
  expect(steps, 'three steps').toHaveLength(3);
  expect(stepBytes(steps).bytes, 'the restored deletion counts').toBeGreaterThanOrEqual(50_000);
  manager.undo();
  expect(text.length, 'yjs passes the empty step and restores the deletion').toBe(50_000);
});

it('an undo past a step that changes nothing (a character typed and deleted at once) counts the deletion it restores: past the cap, refused with the history kept', { timeout: 120_000 }, () => {
  const pane = suggesting('Ada original line.\n\nSecond line.\n');
  try {
    pane.paste([`Tail ${'f'.repeat(90_000)}`]);
    vi.runAllTimers();
    pane.pump();
    pane.paste([`More ${'g'.repeat(50_000)}`]);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'both pastes are stored').toBe(false);
    // He deletes most of his own suggestion natively; its undo restores it as new copies in the record.
    pane.select('Second line.', 12, 12 + 5 + 90_000 + 5 + 49_999);
    pane.backspace();
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the deletion is stored').toBe(false);
    expect(pane.text()).toContain('Second line.g');
    pane.stopCapturing();
    // Within one capture interval: an undo step that changes nothing.
    pane.type('x');
    pane.backspace();
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the keystrokes are stored').toBe(false);
    const text = pane.text();
    expect(text).not.toContain('x');
    const before = pane.changes();
    pane.undo();
    const notice = refusalMessage();
    if (notice) {
      expect(notice, 'refused visibly').toMatch(/nothing was undone/);
      expect(pane.changes(), 'nothing was sent').toBe(before);
      expect(pane.text(), 'F is unchanged').toBe(text);
      vi.runAllTimers();
      pane.pump();
      expect(pane.fork.closed, 'input stays open').toBe(false);
      return;
    }
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'an admitted undo is stored').toBe(false);
    expect(pane.text(), 'it restored the deletion').toContain('Tail f');
  } finally {
    pane.dispose();
  }
});

/** A clipboard holding `text` as both Markdown and plain text. */
const markdownClipboard = (text: string) => ({
  types: ['text/markdown', 'text/plain'],
  getData: (type: string) => (type === 'text/markdown' || type === 'text/plain' ? text : ''),
}) as unknown as DataTransfer;

it('a paste whose line breaks are carriage returns is measured as the paragraphs the paste handler makes of them: stored whole or refused whole', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const before = pane.text().split('a').length;
    if (storedOrRefused(pane, () => pane.pasteData(markdownClipboard('a\r\r'.repeat(1_000)))) === 'stored') {
      expect(pane.text().split('a').length - before, 'every pasted paragraph landed').toBe(1_000);
    }
  } finally {
    pane.dispose();
  }
});

it('a pasted chart is measured with the payload its config encodes to (two entries per array element): past the cap, refused whole', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const config = { type: 'bar', data: [{ label: 'a', value: 1 }], options: { samples: new Array(20_000).fill(0) } };
    expect(storedOrRefused(pane, () => pane.pasteData(markdownClipboard(`\`\`\`moss-chart\n${JSON.stringify(config)}\n\`\`\`\n`)))).toBe('refused');
  } finally {
    pane.dispose();
  }
});

it('a chart whose JSON sits on the opening fence line is measured as the import makes it: stored whole or refused whole, never dropped', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    // Lexical's code transformer reads the rest of the opening line as the code; moss makes a chart of it.
    const config = { type: 'bar', data: [{ label: 'a', value: 1 }], options: { samples: new Array(20_000).fill(0) } };
    expect(storedOrRefused(pane, () => pane.pasteData(markdownClipboard(`\`\`\`moss-chart ${JSON.stringify(config)}\n\`\`\`\n`)))).toBe('refused');
  } finally {
    pane.dispose();
  }
});

it('whitespace-preserving HTML makes a tab node per tab: the paste is measured with them, stored whole or refused whole, never dropped', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const html = `<b style="white-space: pre-wrap">${'\t'.repeat(20_000)}</b>`;
    const clipboard = { types: ['text/html'], getData: (type: string) => (type === 'text/html' ? html : '') } as unknown as DataTransfer;
    expect(storedOrRefused(pane, () => pane.pasteData(clipboard))).toBe('refused');
  } finally {
    pane.dispose();
  }
});

it('a short paste of whitespace-preserving HTML with tabs lands whole, its tab nodes stored with it', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const html = `<b style="white-space: pre-wrap">a\tb\tc</b>`;
    const clipboard = { types: ['text/html'], getData: (type: string) => (type === 'text/html' ? html : '') } as unknown as DataTransfer;
    expect(storedOrRefused(pane, () => pane.pasteData(clipboard))).toBe('stored');
    expect(pane.text()).toContain('a\tb\tc');
  } finally {
    pane.dispose();
  }
});

it('a Lexical clipboard from the pane is measured through the importer the pane uses (its namespace): past the cap, refused whole, never dropped', { timeout: 120_000 }, () => {
  const pane = suggesting('Ada original line.\n\nSecond line.\n');
  try {
    // A copy made in the pane carries its serialized nodes; the HTML and plain flavors here are small.
    const lexical = JSON.stringify({
      namespace: pane.editor._config.namespace,
      nodes: [{ type: 'text', text: 'x'.repeat(300_000), format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
    });
    const clipboard = {
      types: ['application/x-lexical-editor', 'text/html', 'text/plain'],
      getData: (type: string) => (type === 'application/x-lexical-editor' ? lexical : type === 'text/html' ? '<p>small</p>' : type === 'text/plain' ? 'small' : ''),
    } as unknown as DataTransfer;
    expect(storedOrRefused(pane, () => pane.pasteData(clipboard))).toBe('refused');
  } finally {
    pane.dispose();
  }
});

it('a paste over a table-cell selection is measured in that cell: past the cap, refused whole, never dropped', { timeout: 120_000 }, () => {
  const pane = suggesting('Ada original line.\n\n| a | b |\n| --- | --- |\n| c | d |\n');
  try {
    pane.editor.update(() => {
      const table = $getRoot().getChildren().find($isTableNode)!;
      const cells = table.getChildren().flatMap((row) => (row as TableNode).getChildren().filter($isTableCellNode)) as TableCellNode[];
      $setSelection($createTableSelectionFrom(table, cells[0], cells.at(-1)!));
    }, { discrete: true });
    const html = `<p>${'x'.repeat(300_000)}</p>`;
    const clipboard = { types: ['text/html'], getData: (type: string) => (type === 'text/html' ? html : '') } as unknown as DataTransfer;
    expect(storedOrRefused(pane, () => pane.pasteData(clipboard))).toBe('refused');
  } finally {
    pane.dispose();
  }
});

const TABLE_NOTE = 'Ada original line.\n\n| alpha | beta |\n| --- | --- |\n| gamma | delta |\n';
const htmlClipboard = (html: string) => ({ types: ['text/html'], getData: (type: string) => (type === 'text/html' ? html : '') }) as unknown as DataTransfer;
/** Cells `from` to `to` of the note's table selected, as a drag across them makes. */
const selectCells = (pane: ReturnType<typeof suggesting>, from: number, to: number) => pane.editor.update(() => {
  const table = $getRoot().getChildren().find($isTableNode)!;
  const cells = table.getChildren().flatMap((row) => (row as TableNode).getChildren().filter($isTableCellNode)) as TableCellNode[];
  $setSelection($createTableSelectionFrom(table, cells[from], cells[to]));
}, { discrete: true });

it('a short paste over table cells holding the suggester\'s own large text is refused whole, or its one undo brings that text back', { timeout: 120_000 }, () => {
  const pane = suggesting(TABLE_NOTE);
  try {
    pane.select('gamma', 5, 5);
    expect(storedOrRefused(pane, () => pane.paste([`Own ${'o'.repeat(110_000)}`])), 'the large paste in a cell lands').toBe('stored');
    pane.stopCapturing();
    // From the cell holding it to the next: the table plugin writes the paste into the anchor cell, removing his text.
    selectCells(pane, 2, 3);
    if (storedOrRefused(pane, () => pane.pasteData(htmlClipboard('<p>short</p>'))) === 'refused') return;
    pane.undo();
    expect(refusalMessage(), 'its undo is admitted').toBe('');
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'and stored').toBe(false);
    expect(pane.text(), 'one undo brings his text back').toContain(`Own ${'o'.repeat(110_000)}`);
  } finally {
    pane.dispose();
  }
});

it('a paste over table cells holding another author\'s text is refused whole, or strikes that text and keeps it visible', { timeout: 120_000 }, () => {
  const pane = suggesting(TABLE_NOTE);
  try {
    selectCells(pane, 0, 3);
    if (storedOrRefused(pane, () => pane.paste(['cellpaste'])) === 'refused') return;
    for (const word of ['alpha', 'beta', 'gamma', 'delta']) expect(pane.text(), `${word} stays, struck`).toContain(word);
    expect(pane.struck(), 'the replaced text is struck').toBeGreaterThan(0);
  } finally {
    pane.dispose();
  }
});

it('a table pasted at a caret in a cell, which overwrites the cells from there, is refused whole, or strikes what it overwrites', { timeout: 120_000 }, () => {
  const pane = suggesting(TABLE_NOTE);
  try {
    pane.select('gamma', 5, 5);
    if (storedOrRefused(pane, () => pane.pasteData(htmlClipboard('<table><tr><td>one</td><td>two</td></tr></table>'))) === 'refused') return;
    for (const word of ['gamma', 'delta']) expect(pane.text(), `${word} stays, struck`).toContain(word);
    expect(pane.struck(), 'the overwritten text is struck').toBeGreaterThan(0);
  } finally {
    pane.dispose();
  }
});

it.each([
  ['a paste over another author\'s word, splitting its paragraph', 'paste'],
  ['Enter mid-paragraph (the control)', 'enter'],
] as const)('%s, then one undo, leaves nothing suggested: no hunk, nothing painted for either side, and the system closes the record once idle; a redo first brings it back', { timeout: 120_000 }, (_name, act) => {
  const pane = suggesting();
  try {
    const original = pane.text();
    const settle = () => {
      vi.runAllTimers();
      pane.pump();
    };
    const doIt = () => {
      if (act === 'paste') {
        pane.select('Intro line', 6, 10);
        pane.paste(['Pasted one', 'Pasted two']);
      } else {
        pane.select('Intro line', 6, 6);
        pane.enter();
      }
      settle();
    };
    /** The record's hunks. */
    const hunks = () => {
      const [record] = openRecords(pane.live);
      const preview = previewRecord(pane.live, record!.meta.id);
      if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
      return preview.hunks.length;
    };
    /** The suggester's painted inserts in F, and the owner's Edit-mode strikes over B. */
    const painted = () => {
      const pending = pendingInserts(pane.fork.doc, pane.fork.ownClients(), pane.live);
      let inserts = 0;
      for (const [, structs] of pane.fork.doc.store.clients) {
        for (const struct of structs) {
          if (!(struct instanceof Y.Item) || struct.deleted || !(struct.content instanceof Y.ContentString)) continue;
          for (let i = 0; i < struct.length; i += 1) if (pending(Y.createID(struct.id.client, struct.id.clock + i))) inserts += 1;
        }
      }
      const built = new Composite(pane.live).build();
      try {
        const struck = [...struckByRecord(pane.live, new Set(built.valid), built).values()].flat().reduce((sum, span) => sum + span.len, 0);
        return { inserts, struck };
      } finally {
        destroyView(built);
      }
    };

    doIt();
    expect(pane.text()).not.toBe(original);
    expect(hunks(), 'the change is shown').toBeGreaterThan(0);
    pane.undo();
    settle();
    expect(pane.text(), 'one undo takes it back').toBe(original);
    expect(hunks(), 'nothing is suggested after the undo').toBe(0);
    expect(painted(), 'nothing is painted after the undo').toEqual({ inserts: 0, struck: 0 });

    pane.redo();
    settle();
    expect(pane.text(), 'one redo brings it back').not.toBe(original);
    expect(hunks(), 'and shows it again').toBeGreaterThan(0);
    pane.undo();
    settle();
    expect(pane.text()).toBe(original);
    expect(hunks(), 'nothing is suggested after the second undo').toBe(0);
    expect(painted(), 'nothing is painted after the second undo').toEqual({ inserts: 0, struck: 0 });
    expect(pane.fork.closed, 'nothing refused').toBe(false);

    // Idle, the record that changes nothing is rejected by the system: no pending suggestion is left.
    const [record] = openRecords(pane.live);
    expect(reviewPreview(pane.live, record!.meta.id, { now: record!.meta.updatedAt + EMPTY_IDLE_MS })).toMatchObject({ ok: true, hunks: [], closed: true });
    expect(openRecords(pane.live), 'no pending suggestion').toEqual([]);
  } finally {
    pane.dispose();
  }
});

it.each([
  ['a paste over another author\'s word, splitting its paragraph', 'paste', false],
  ['Enter mid-paragraph', 'enter', false],
  // T5.S14: the second undo restores the rest as copies of the first undo's copies.
  ['a paste over another author\'s word, splitting its paragraph, undone, redone and', 'paste', true],
  ['Enter mid-paragraph, undone, redone and', 'enter', true],
] as const)('%s, undone, then typing in the restored rest suggests only what was typed: the rest is painted for neither side and the card shows only the typed characters', { timeout: 120_000 }, (_name, act, again) => {
  const pane = suggesting();
  try {
    const settle = () => {
      vi.runAllTimers();
      pane.pump();
    };
    if (act === 'paste') {
      pane.select('Intro line', 6, 10);
      pane.paste(['Pasted one', 'Pasted two']);
    } else {
      pane.select('Intro line', 6, 6);
      pane.enter();
    }
    settle();
    pane.undo();
    settle();
    if (again) {
      pane.redo();
      settle();
      pane.undo();
      settle();
    }
    expect(pane.text()).toContain('Intro line stays.');
    pane.stopCapturing();
    // One character at the line's end, and one inside the restored rest.
    pane.select('Intro line', 17, 17);
    pane.type('!');
    settle();
    pane.stopCapturing();
    pane.select('Intro line', 13, 13);
    pane.type('?');
    settle();
    expect(pane.text()).toContain('Intro line st?ays.!');
    expect(pane.fork.closed, 'nothing refused').toBe(false);

    const pending = pendingInserts(pane.fork.doc, pane.fork.ownClients(), pane.live);
    const inserted: string[] = [];
    for (const [, structs] of pane.fork.doc.store.clients) {
      for (const struct of structs) {
        if (!(struct instanceof Y.Item) || struct.deleted || !(struct.content instanceof Y.ContentString)) continue;
        for (let i = 0; i < struct.length; i += 1) if (pending(Y.createID(struct.id.client, struct.id.clock + i))) inserted.push(struct.content.str[i]!);
      }
    }
    expect(inserted.sort(), 'the suggester sees only what he typed painted').toEqual(['!', '?']);
    const built = new Composite(pane.live).build();
    try {
      const struck = [...struckByRecord(pane.live, new Set(built.valid), built).values()].flat().reduce((sum, span) => sum + span.len, 0);
      expect(struck, 'the owner sees none of her words struck').toBe(0);
    } finally {
      destroyView(built);
    }
    const records = openRecords(pane.live);
    const rows = records.flatMap((record) => {
      const preview = previewRecord(pane.live, record.meta.id);
      if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
      return describePreview(preview);
    });
    expect(rows.filter((row) => row.kind !== 'insert').map((row) => row.text), 'the card removes nothing').toEqual([]);
    expect(rows.map((row) => row.text).sort(), 'the card adds only the typed characters').toEqual(['!', '?']);
  } finally {
    pane.dispose();
  }
});

it.each([
  ['a paste over another author\'s word, splitting its paragraph', 'paste'],
  ['Enter mid-paragraph', 'enter'],
] as const)('T5.S14: %s, undone, redone and undone again, then accepted: nothing is re-authored and no comment detaches', { timeout: 120_000 }, (_name, act) => {
  const pane = suggesting();
  try {
    const settle = () => {
      vi.runAllTimers();
      pane.pump();
    };
    const ids = JSON.stringify(spansOfText(pane.live, 'Intro line stays.'));
    // A comment on "line stays", as comments mint its start (tree-anchor positionAt).
    const projection = project(pane.live);
    const comment = positionAt(projection, projection.text.indexOf('line stays'), 0)!;
    if (act === 'paste') {
      pane.select('Intro line', 6, 10);
      pane.paste(['Pasted one', 'Pasted two']);
    } else {
      pane.select('Intro line', 6, 6);
      pane.enter();
    }
    settle();
    for (const step of [pane.undo, pane.redo, pane.undo]) {
      step();
      settle();
    }
    expect(pane.fork.closed, 'nothing refused').toBe(false);
    const [record] = openRecords(pane.live);
    const preview = previewRecord(pane.live, record!.meta.id);
    if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
    expect(preview.hunks, 'nothing is shown').toEqual([]);
    const events: string[] = [];
    pane.fork.on((event) => events.push(event.type));
    expect(acceptRecord(pane.live, record!.meta.id, { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
    expect(JSON.stringify(spansOfText(pane.live, 'Intro line stays.')), 'the paragraph keeps its original items and authors').toBe(ids);
    expect(events, 'the fork, which holds the copies, rebuilds from the body').toContain('rebuild');
    const anchor = Y.getItem(pane.live.store, comment.item!);
    expect(anchor instanceof Y.Item && !anchor.deleted, 'the comment stays anchored').toBe(true);
  } finally {
    pane.dispose();
  }
});

/** Each live character of the paragraph whose text starts with `prefix`, with the Yjs id it has. */
function charsOf(doc: Y.Doc, prefix: string): [string, string][] {
  for (const { insert } of doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]) {
    if (!(insert instanceof Y.XmlText)) continue;
    const chars: [string, string][] = [];
    for (let item = insert._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
      for (let i = 0; i < item.length; i += 1) chars.push([item.content.str[i]!, `${item.id.client}:${item.id.clock + i}`]);
    }
    if (chars.map(([c]) => c).join('').startsWith(prefix)) return chars;
  }
  return [];
}

it.each([
  // Beside the restored rest: before it and after it.
  ['beside', 6, 'Intro ?line stays.!'],
  // Inside it, between two of its restored characters.
  ['inside', 13, 'Intro line st?ays.!'],
] as const)('T5.S14: typing %s the rest an undone, redone and undone Enter restored, then accepted, lands what the card showed on the original items, the comment anchored', { timeout: 120_000 }, (_name, at, expected) => {
  const pane = suggesting();
  try {
    const settle = () => {
      vi.runAllTimers();
      pane.pump();
    };
    const original = charsOf(pane.live, 'Intro line stays.');
    const projection = project(pane.live);
    const comment = positionAt(projection, projection.text.indexOf('line stays'), 0)!;
    pane.select('Intro line', 6, 6);
    pane.enter();
    settle();
    for (const step of [pane.undo, pane.redo, pane.undo]) {
      step();
      settle();
    }
    pane.stopCapturing();
    pane.select('Intro line', 17, 17);
    pane.type('!');
    settle();
    pane.stopCapturing();
    pane.select('Intro line', at, at);
    pane.type('?');
    settle();
    expect(pane.text()).toContain(expected);
    expect(pane.fork.closed, 'nothing refused').toBe(false);
    const rows: string[] = [];
    for (const record of openRecords(pane.live)) {
      const preview = previewRecord(pane.live, record.meta.id);
      if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
      rows.push(...describePreview(preview).map((row) => `${row.kind} ${row.text}`));
      expect(acceptRecord(pane.live, record.meta.id, { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
    }
    expect(rows.sort(), 'the card shows only the typed characters').toEqual(['insert !', 'insert ?']);
    const landed = charsOf(pane.live, 'Intro');
    expect(landed.map(([c]) => c).join(''), 'accept lands what the card showed').toBe(expected);
    expect(landed.filter(([c]) => c !== '?' && c !== '!'), 'the restored rest lands as its original items, authors unchanged').toEqual(original);
    const anchor = Y.getItem(pane.live.store, comment.item!);
    expect(anchor instanceof Y.Item && !anchor.deleted, 'the comment on the rest stays anchored').toBe(true);
  } finally {
    pane.dispose();
  }
});

it.each([
  // After " More", in the paragraph with the real change, under the record's lease.
  ['in the record', null],
  // Inside the restored rest, after one of its kept copies.
  ['beside a kept copy', 13],
] as const)('T5.S14: typing %s still unacknowledged when accept keeps an undone Enter is refused loudly with its block offered back, never dropped by the rebuild', { timeout: 120_000 }, (_name, at) => {
  const pane = suggesting();
  try {
    const settle = () => {
      vi.runAllTimers();
      pane.pump();
    };
    pane.select('Intro line', 6, 6);
    pane.enter();
    settle();
    for (const step of [pane.undo, pane.redo, pane.undo]) {
      step();
      settle();
    }
    pane.stopCapturing();
    pane.select('Closing line', 23, 23);
    pane.type(' More');
    settle();
    const [record] = openRecords(pane.live);
    // Not answered yet: the frame is in flight when the editor accepts.
    if (at !== null) pane.select('Intro line', at, at);
    pane.type('!');
    expect(pane.fork.owes).toBe(true);
    const preview = previewRecord(pane.live, record!.meta.id);
    if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
    const events: string[] = [];
    pane.fork.on((event) => events.push(event.type));
    expect(acceptRecord(pane.live, record!.meta.id, { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
    expect(readMeta(pane.live, record!.meta.id)?.kept, 'accept kept the undone paragraph').toBe(true);
    expect(events, 'F does not rebuild under the frame in flight').not.toContain('rebuild');
    expect(pane.fork.closed, 'input closes').toBe(true);
    expect(pane.unsaved.join('\n'), 'the unacknowledged typing is offered back').toContain('!');
  } finally {
    pane.dispose();
  }
});

it('T5.S14: a record with a real change and an identity-only block paints only the real change, for either side', () => {
  const live = seededBody('Intro line stays.\n\nClosing line stays too.\n');
  const paragraph = (doc: Y.Doc, prefix: string) => {
    const blocks = (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert);
    return blocks.find((x) => x instanceof Y.XmlText && (x.toDelta() as { insert: unknown }[]).some(({ insert }) => typeof insert === 'string' && insert.startsWith(prefix))) as Y.XmlText;
  };
  forgeRecord(live, 'g', [opOn(live, 'body', (copy) => {
    const intro = paragraph(copy, 'Intro');
    const at = (intro.toDelta() as { insert: unknown }[]).findIndex(({ insert }) => typeof insert === 'string');
    intro.delete(at, 'Intro line stays.'.length);
    intro.insert(at, 'Intro line stays.');
    const closing = paragraph(copy, 'Closing');
    closing.insert(closing.length, ' More.');
  })]);
  const built = new Composite(live).build();
  try {
    expect(built.valid).toEqual(['g']);
    const pending = pendingInserts(built.doc, new Set(built.clients.keys()), live);
    let painted = '';
    for (const [, structs] of built.doc.store.clients) {
      for (const struct of structs) {
        if (!(struct instanceof Y.Item) || struct.deleted || !(struct.content instanceof Y.ContentString)) continue;
        for (let i = 0; i < struct.length; i += 1) if (pending(Y.createID(struct.id.client, struct.id.clock + i))) painted += struct.content.str[i];
      }
    }
    expect(painted, 'only the real change is painted as inserted').toBe(' More.');
    const struck = [...struckByRecord(live, new Set(built.valid), built).values()].flat().reduce((sum, span) => sum + span.len, 0);
    expect(struck, 'nothing is painted struck').toBe(0);
  } finally {
    destroyView(built);
  }
});

it.each([
  ['at a caret', 5, 5],
  ['over the styled words', 0, 11],
] as const)('a many-line paste %s in highlighted text is measured with the selection\'s format and style, which every pasted line takes: the copy writes what the pane writes, stored whole or refused whole', { timeout: 120_000 }, (_name, anchor, focus) => {
  const pane = suggesting('Intro ==highlighted words== stay.\n\nClosing line stays too.\n');
  try {
    // As the browser's selection takes them from the anchor's text node (Lexical $internalCreateRangeSelection).
    const selectStyled = () => pane.editor.update(() => {
      select('highlighted', anchor, focus);
      const selection = $getSelection();
      const node = textNode('highlighted');
      if ($isRangeSelection(selection)) {
        selection.format = node.getFormat();
        selection.style = node.getStyle();
      }
    }, { discrete: true });
    selectStyled();
    expect(pane.editor.getEditorState().read(() => textNode('highlighted').getStyle()), 'the body text is highlighted').not.toBe('');
    const lines = Array.from({ length: 200 }, (_, i) => `l${i}`);
    const event = { clipboardData: plainClipboard(lines.join('\n')), preventDefault: () => {}, stopPropagation: () => {} } as unknown as ClipboardEvent;
    let measured: number | 'cells' | null = null;
    pane.editor.update(() => {
      measured = measurePaste(pane.editor, pane.fork, event, $pasteAt(anchor !== focus), pasteStack);
    }, { discrete: true });
    expect(typeof measured, 'the copy ran the paste').toBe('number');
    let written = 0;
    const count = (update: Uint8Array) => {
      written += update.byteLength;
    };
    pane.fork.doc.on('update', count);
    selectStyled();
    pane.pasteData(plainClipboard(lines.join('\n')));
    pane.fork.doc.off('update', count);
    expect(refusalMessage(), 'a short paste is admitted').toBeFalsy();
    expect(written, 'the paste wrote').toBeGreaterThan(0);
    expect(measured as unknown as number, 'the copy measures at least what the pane writes').toBeGreaterThanOrEqual(written);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'the DocDO stores it').toBe(false);
  } finally {
    pane.dispose();
  }

  // Near the record cap: every line takes the highlight's style twice (its paragraph's and its text's).
  for (const length of [400, 550, 700]) {
    const near = suggesting('Intro ==highlighted words== stay.\n\nClosing line stays too.\n');
    try {
      near.editor.update(() => {
        select('highlighted', anchor, focus);
        const selection = $getSelection();
        const node = textNode('highlighted');
        if ($isRangeSelection(selection)) {
          selection.format = node.getFormat();
          selection.style = node.getStyle();
        }
      }, { discrete: true });
      storedOrRefused(near, () => near.pasteData(plainClipboard(Array.from({ length }, (_, i) => `line ${i}`).join('\n'))));
    } finally {
      near.dispose();
    }
  }
});
