// @vitest-environment jsdom
// T5.R2 (checker P1): a large paste in Suggest mode lands whole in F or is refused whole (T3.S6), and a refusal of any
// of its ops offers every pasted block back (suggestions.md §5). A paste past the record cap is refused before any of
// it reaches F; one that fits lands in one task, so a refusal arriving later still finds all of its ops unanswered.
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestRequest } from '@moss-multi/protocol/suggest';
import { SUGGEST_LIMITS } from '@moss-multi/protocol/suggest';
import { $getRoot, $getSelection, COMMAND_PRIORITY_EDITOR, REDO_COMMAND, type Klass, type LexicalNode } from 'lexical';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { SuggestFork } from '../../../../../../packages/sync/src/suggest/client.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { readRecord } from '../../../../../../packages/sync/src/suggest/records.ts';
import { nodeRegistry } from '../../../../../../packages/sync/src/suggest/review.ts';
import { seededBody, SUGGESTER } from '../../../../../../packages/sync/src/suggest/test-support.ts';
import { $insertBlocks, pasteLarge, planPlainText } from '../../large-paste.ts';
import { refusalMessage } from '../../refusal.ts';
import { createBindingUndoManager } from '../undo.ts';

beforeEach(() => {
  // jsdom's Performance may lack User Timing; the paste marks its batches with it.
  const perf = performance as unknown as Record<string, unknown>;
  if (typeof perf.mark !== 'function') perf.mark = () => undefined;
  if (typeof perf.measure !== 'function') perf.measure = () => undefined;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A suggester's pane on F, with the body's undo (which holds a paste's batches in one step) and a reachable DocDO. */
function suggesting() {
  const live = seededBody('Intro line stays.\n\nClosing line stays too.\n');
  let n = 0;
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => `r${(n += 1)}` });
  const outbox: SuggestRequest[] = [];
  const fork = new SuggestFork(live, { me: SUGGESTER.id, name: SUGGESTER.name, send: (request) => outbox.push(request), now: () => 1_000 });
  const bound = bindEditor(fork.doc);
  // The pane's editor, unlike this headless one, takes root listeners; in jsdom it has no root element.
  Object.assign(bound.editor, { registerRootListener: () => () => {}, getRootElement: () => null, getElementByKey: () => null });
  const undo = createBindingUndoManager(bound.binding);
  (bound.editor as unknown as Record<symbol, unknown>)[Symbol.for('@lexical/yjs/UndoManager')] = undo;
  // The collaboration plugin's redo, which a paste's sliced redo takes precedence over.
  bound.editor.registerCommand(REDO_COMMAND, () => {
    undo.redo();
    return true;
  }, COMMAND_PRIORITY_EDITOR);
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
  bound.editor.update(() => $getRoot().getLastChildOrThrow().selectEnd(), { discrete: true });
  const nodes = [...bound.editor._nodes.values()].map(({ klass }) => klass) as Klass<LexicalNode>[];
  const paste = (lines: string[]) => pasteLarge(bound.editor, {
    plan: planPlainText(nodes, lines.join('\n')),
    nodes,
    $restore: () => false,
    $insert: (blocks) => $insertBlocks(blocks, $getSelection()!, (some, at) => at.insertNodes(some)),
  });
  return {
    fork,
    live,
    unsaved,
    paste,
    pump,
    undo: () => {
      undo.undo();
      bound.editor.update(() => {}, { discrete: true });
    },
    redo: () => bound.editor.dispatchCommand(REDO_COMMAND, undefined),
    text: () => bound.editor.getEditorState().read(() => $getRoot().getTextContent()),
    dispose: () => {
      undo.destroy();
      bound.dispose();
      fork.dispose();
    },
  };
}

it('a paste refused after its first batch reached the DocDO offers back every pasted paragraph', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    // More than one batch's worth, under the record cap (a paragraph is some 300 bytes of ops); `<i>` marks each, the
    // middle ones included (the first batch also places the last).
    const lines = Array.from({ length: 300 }, (_, i) => `para <${i}>`);
    const before = pane.fork.sent;
    pane.paste(lines);
    for (let tick = 0; pane.fork.sent === before && tick < 1_000; tick += 1) vi.advanceTimersToNextTimer();
    expect(pane.fork.sent, 'the first batch reached the DocDO').toBeGreaterThan(before);
    // The DocDO refuses the first op (record-cap, ops-cap: any reason) while the rest of the paste may be pending.
    pane.fork.receive({ t: 'suggest-refused', record: pane.fork.record, reason: 'record-cap' });
    vi.runAllTimers();
    // Nothing was acked, so nothing was saved: every paragraph is offered back.
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
    const before = pane.fork.sent;
    pane.paste(lines);
    // The notice clears itself on a timer: read it once it shows.
    while (!refusalMessage() && vi.getTimerCount() > 0) vi.advanceTimersToNextTimer();
    expect(refusalMessage(), 'refused visibly').toMatch(/suggest/i);
    vi.runAllTimers();
    expect(pane.fork.sent, 'no op was sent').toBe(before);
    expect(pane.text(), 'F is unchanged').toBe(text);
    expect(pane.fork.closed, 'input stays open').toBe(false);
  } finally {
    pane.dispose();
  }
});

/** Bytes of ops record `id` holds. */
const recordBytes = (pane: ReturnType<typeof suggesting>, id: string) => readRecord(pane.live, id)!.ops.reduce((sum, op) => sum + op.update.byteLength, 0);

it('a paste that would take the open record it extends past the record cap is refused whole', { timeout: 120_000 }, () => {
  const pane = suggesting();
  try {
    const cap = SUGGEST_LIMITS.recordOpsBytes;
    // The first paste lands as one record, well under the cap.
    const first = Array.from({ length: 250 }, (_, i) => `first <${i}> ${'x'.repeat(200)}`);
    pane.paste(first);
    vi.runAllTimers();
    pane.pump();
    const record = pane.fork.record!;
    const held = recordBytes(pane, record);
    expect(held, 'the first paste landed, a fair share of the cap').toBeGreaterThan(cap * 0.2);
    expect(held, 'under half the cap').toBeLessThan(cap * 0.5);
    // The second, at the end of the first, fits the cap alone, not with what the record already holds.
    const perLine = held / first.length;
    const count = Math.ceil((cap * 1.05 - held) / perLine);
    expect(count * perLine, 'the second paste alone fits').toBeLessThan(cap * 0.85);
    const second = Array.from({ length: count }, (_, i) => `second <${i}> ${'x'.repeat(200)}`);
    const text = pane.text();
    const before = pane.fork.sent;
    pane.paste(second);
    while (!refusalMessage() && vi.getTimerCount() > 0) vi.advanceTimersToNextTimer();
    expect(refusalMessage(), 'refused visibly').toMatch(/suggest/i);
    vi.runAllTimers();
    expect(pane.fork.sent, 'no op was sent').toBe(before);
    expect(pane.text(), 'F is unchanged').toBe(text);
    pane.pump();
    expect(pane.fork.closed, 'input stays open').toBe(false);
    expect(recordBytes(pane, record), 'the record holds the first paste only').toBe(held);
  } finally {
    pane.dispose();
  }
});

it('a refusal during the redo of a batched paste offers back every redone paragraph', { timeout: 120_000 }, () => {
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
    for (let tick = 0; pane.fork.sent === before && tick < 1_000; tick += 1) vi.advanceTimersToNextTimer();
    expect(pane.fork.sent, 'the redo reached the DocDO').toBeGreaterThan(before);
    // The DocDO refuses the redo's first op (doc-cap, open-cap, the record closing: any reason).
    pane.fork.receive({ t: 'suggest-refused', record: pane.fork.record, reason: 'doc-cap' });
    vi.runAllTimers();
    const offered = pane.unsaved.join('\n');
    const lost = lines.filter((line) => !offered.includes(line));
    expect(lost.length, `paragraphs neither saved nor offered back, e.g. ${lost.slice(0, 3).join(', ')}`).toBe(0);
  } finally {
    pane.dispose();
  }
});
