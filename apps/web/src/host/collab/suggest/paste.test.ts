// @vitest-environment jsdom
// T5.R2: in Suggest mode a large paste (T3.S6) is never batched. It is admitted against every suggestion cap before
// anything changes, the deletion of a selection it replaces included, then lands in one transaction (one op, one
// record), or is refused whole with nothing changed (suggestions.md §5). Its undo and its redo are one step each.
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestRequest } from '@moss-multi/protocol/suggest';
import { SUGGEST_LIMITS } from '@moss-multi/protocol/suggest';
import {
  $getRoot, $getSelection, COMMAND_PRIORITY_EDITOR, COMMAND_PRIORITY_HIGH, PASTE_COMMAND, REDO_COMMAND, UNDO_COMMAND, type Klass, type LexicalNode,
} from 'lexical';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { GROUP_IDLE_MS, SuggestFork } from '../../../../../../packages/sync/src/suggest/client.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { openRecords, readRecord } from '../../../../../../packages/sync/src/suggest/records.ts';
import { nodeRegistry } from '../../../../../../packages/sync/src/suggest/review.ts';
import { seededBody, select, SUGGESTER } from '../../../../../../packages/sync/src/suggest/test-support.ts';
import { $insertBlocks, pasteLarge, planPlainText, registerWholePaste } from '../../large-paste.ts';
import { refusalMessage } from '../../refusal.ts';
import { publishBinding } from '../binding-registry.ts';
import { createBindingUndoManager } from '../undo.ts';
import { registerSuggestRouting } from './routing.ts';

/** The payload bytes the DocDO last said it counts for a doc (doc-session.ts), withheld payloads included. */
const counted = new WeakMap<Y.Doc, number>();
vi.mock('../doc-session.ts', async (original) => ({
  ...(await original<typeof import('../doc-session.ts')>()),
  countedPayloadBytes: (doc: Y.Doc) => counted.get(doc) ?? 0,
}));

beforeEach(() => {
  // jsdom's Performance may lack User Timing; the paste marks its steps with it.
  const perf = performance as unknown as Record<string, unknown>;
  if (typeof perf.mark !== 'function') perf.mark = () => undefined;
  if (typeof perf.measure !== 'function') perf.measure = () => undefined;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * A suggester's pane on F: the body's undo, the routing, and a paste handler that lands every paste through pasteLarge,
 * as the MarkdownEditor seam does a large one; a reachable DocDO.
 */
function suggesting(markdown = 'Intro line stays.\n\nClosing line stays too.\n') {
  const live = seededBody(markdown);
  let n = 0;
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => `r${(n += 1)}` });
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
  const nodes = [...editor._nodes.values()].map(({ klass }) => klass) as Klass<LexicalNode>[];
  let clipboard = '';
  const stops = [
    publishBinding(editor, bound.binding),
    // The collaboration plugin's undo and redo, which a paste's sliced redo and the routing take precedence over.
    editor.registerCommand(UNDO_COMMAND, () => {
      undo.undo();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    editor.registerCommand(REDO_COMMAND, () => {
      undo.redo();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    // The seam: this handler lands every paste whole.
    registerWholePaste(editor, () => true),
    editor.registerCommand(PASTE_COMMAND, () => {
      pasteLarge(editor, {
        plan: planPlainText(nodes, clipboard),
        nodes,
        $restore: () => false,
        $insert: (blocks) => $insertBlocks(blocks, $getSelection()!, (some, at) => at.insertNodes(some)),
      });
      return true;
    }, COMMAND_PRIORITY_HIGH),
    registerSuggestRouting(editor, fork),
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
  /** A real paste command of `lines`, as plain text, run to its end. */
  const paste = (lines: string[]) => {
    clipboard = lines.join('\n');
    editor.dispatchCommand(PASTE_COMMAND, { clipboardData: null } as unknown as ClipboardEvent);
  };
  return {
    fork,
    live,
    unsaved,
    paste,
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
    undo: () => editor.update(() => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
    }, { discrete: true }),
    redo: () => editor.update(() => {
      editor.dispatchCommand(REDO_COMMAND, undefined);
    }, { discrete: true }),
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

it('an admissible large paste lands in one op as one record, and its undo and its redo are one op each', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    // Many batches' worth in Edit mode (a paragraph is some 300 bytes of ops), under the record cap.
    const lines = Array.from({ length: 300 }, (_, i) => `para <${i}>`);
    const before = pane.fork.sent;
    pane.paste(lines);
    vi.runAllTimers();
    expect(pane.fork.sent - before, 'the paste is one op').toBe(1);
    pane.pump();
    expect(pane.fork.closed, 'admitted').toBe(false);
    const records = openRecords(pane.live, SUGGESTER.id);
    expect(records.map((record) => record.ops.length), 'one record holds it').toEqual([1]);
    expect(pane.text()).toContain('para <0>');
    expect(pane.text()).toContain('para <299>');

    pane.undo();
    vi.runAllTimers();
    expect(pane.fork.sent - before, 'one undo, one op').toBe(2);
    expect(pane.text(), 'one undo takes all of it back').not.toMatch(/para <\d+>/);
    pane.pump();
    pane.redo();
    vi.runAllTimers();
    expect(pane.fork.sent - before, 'one redo, one op').toBe(3);
    expect(pane.text(), 'one redo brings all of it back').toContain('para <0>');
    expect(pane.text()).toContain('para <299>');
    pane.pump();
    expect(pane.fork.closed, 'nothing refused').toBe(false);
  } finally {
    pane.dispose();
  }
});

it('a refusal of the paste offers back every pasted paragraph', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const lines = Array.from({ length: 300 }, (_, i) => `para <${i}>`);
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
    const lines = Array.from({ length: 300 }, (_, i) => `para <${i}>`);
    pane.paste(lines);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'admitted').toBe(false);
    expect(pane.fork.struck().reduce((sum, span) => sum + span.len, 0), 'the selection is struck').toBe(4);
    expect(pane.text()).toContain('para <0>');
    expect(pane.text()).toContain('para <299>');
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
    const first = [`first ${'x'.repeat(80_000)}`];
    pane.paste(first);
    vi.runAllTimers();
    pane.pump();
    const record = pane.fork.record!;
    const held = recordBytes(pane, record);
    expect(held, 'the first paste landed, a fair share of the cap').toBeGreaterThan(cap * 0.2);
    expect(held, 'under half the cap').toBeLessThan(cap * 0.5);
    // The second, at the same caret, fits the cap alone, not with what the record already holds.
    const perChar = held / first[0].length;
    const count = Math.ceil((cap * 1.05 - held) / perChar);
    expect(count * perChar, 'the second paste alone fits').toBeLessThan(cap * 0.85);
    const second = [`second ${'x'.repeat(count)}`];
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
    const lines = Array.from({ length: 300 }, (_, i) => `para <${i}>`);
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
    const first = [`first ${'x'.repeat(80_000)}`];
    pane.paste(first);
    vi.runAllTimers();
    pane.pump();
    const record = pane.fork.record!;
    const held = recordBytes(pane, record);
    // Past the idle gap the next edit starts a new group, under the spare lease; at the same caret it builds on the
    // first paste's items, so its record merges the first one (client.ts #forward), and the merge is under the cap.
    pane.idle(GROUP_IDLE_MS + 1_000);
    const perChar = held / first[0].length;
    const count = Math.ceil((cap * 1.05 - held) / perChar);
    expect(count * perChar, 'the second paste alone fits').toBeLessThan(cap * 0.85);
    const text = pane.text();
    const before = pane.changes();
    pane.paste([`second ${'x'.repeat(count)}`]);
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
    const lines = Array.from({ length: 300 }, (_, i) => `para <${i}>`);
    pane.paste(lines);
    vi.runAllTimers();
    pane.pump();
    const struck = () => pane.fork.struck().reduce((sum, span) => sum + span.len, 0);
    expect(struck(), 'the selection is struck').toBe(4);
    expect(pane.text()).toContain('para <299>');

    pane.undo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.text(), 'one undo takes the paste back').not.toMatch(/para <\d+>/);
    expect(struck(), 'and the strike').toBe(0);

    pane.redo();
    vi.runAllTimers();
    pane.pump();
    expect(pane.text(), 'one redo brings the paste back').toContain('para <299>');
    expect(struck(), 'and the strike').toBe(4);
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

it('a paste inside a long paragraph that fits with the paragraph\'s rest lands as one suggestion, the DocDO refusing nothing', { timeout: 120_000 }, () => {
  const pane = suggesting(`Ada ${'q'.repeat(150_000)}\n\nSecond line.\n`);
  try {
    pane.select('Ada', 0, 3);
    pane.paste([`One ${'a'.repeat(20_000)}`, `Two ${'b'.repeat(20_000)}`]);
    vi.runAllTimers();
    pane.pump();
    expect(pane.fork.closed, 'admitted, and stored').toBe(false);
    expect(pane.text()).toContain('Two bbb');
    expect(openRecords(pane.live, SUGGESTER.id), 'one suggestion holds the strike and the paste').toHaveLength(1);
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
    pane.paste(Array.from({ length: 300 }, (_, i) => `para <${i}>`));
    expect(noticed(), 'refused visibly').not.toBe('');
    expect(pane.requests(), 'nothing was sent, no strike either').toBe(before);
    expect(pane.fork.struck(), 'nothing is struck').toEqual([]);
    expect(pane.text(), 'F is unchanged').toBe(text);
    expect(pane.selected(), 'the selection is kept').toBe('line');
  } finally {
    pane.dispose();
  }
});
