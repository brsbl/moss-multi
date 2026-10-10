// T3.S6 (DEVIATIONS 22): a large paste lands whole, or is refused whole before anything of it is applied. Moss at
// the pin split the text into 12,000-character chunks and dropped every chunk after the first. Here the paste is
// parsed once, off the live editor, into units: whole blocks, or the items and rows of a list or table too large to
// go in at once. It is first replayed on a scratch editor bound to a scratch doc, a batch at a time, which gives the
// bytes it adds and its largest indivisible piece; past the note's cap or the frame cap it is refused, visibly. Then
// it lands in batches of units, the main thread free between them, all one undo step. Any input in the meantime (a
// key, a click, another paste, an undo, the pane closing) first lands the rest at once, so nothing is left pending.
import { createBinding, syncLexicalUpdateToYjs, type Provider } from '@lexical/yjs';
import { CLIENT_FRAME_MAX_BYTES, STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { SUGGEST_LIMITS, type IdSpan, type SuggestRefusal } from '@moss-multi/protocol/suggest';
import { encodePayloadFrame, PAYLOAD_UPDATE } from '@moss-multi/protocol/sync';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { isPayloadType, payloadDocsFor, payloadMap, seedPayload, type SlicedRedo } from '@moss-multi/sync/payload-docs';
import { seedOf } from '@moss-multi/sync/registers';
import { forkOf, type ForkView } from '@moss-multi/sync/suggest/forks';
import { splitUpdate } from '@moss-multi/sync/update-pieces';
import {
  $createLineBreakNode, $createParagraphNode, $createTabNode, $createTextNode, $getNodeByKey, $getRoot, $getSelection,
  $isDecoratorNode, $isElementNode, $isNodeSelection, $isRangeSelection, $isRootOrShadowRoot, $isTextNode, $parseSerializedNode, $setSelection,
  COMMAND_PRIORITY_CRITICAL, createEditor, REDO_COMMAND, UNDO_COMMAND, type BaseSelection, type ElementNode,
  type Klass, type LexicalEditor, type LexicalNode, type NodeKey, type PointType, type SerializedElementNode, type SerializedLexicalNode,
} from 'lexical';
import * as Y from 'yjs';
import { PIECE_BYTES } from './collab/outbox.ts';
import { countedPayloadBytes, WRITE_REFUSED } from './collab/doc-session.ts';
import { markLanding, runBatchGeometry } from './collab/landing.ts';
import { DirLift, LARGE_CHILDREN } from './dir-lift.ts';
import { markUnacked } from './collab/unacked.ts';
import { refuseInput } from './refusal.ts';

const COLLAB_UNDO_MANAGER = Symbol.for('@lexical/yjs/UndoManager');

/** Y.UndoManager, or the host's BodyUndo around one (`root`), which can hold a step open. */
type CollabUndo = {
  stopCapturing(): void;
  doc?: Y.Doc;
  root?: { doc: Y.Doc };
  hold?: () => () => void;
  /** BodyUndo's steps; a step's `stamp` names the action that made it. */
  undoStack?: readonly { stamp: unknown }[];
  redone?: { stamp: unknown }[];
  redoInSlices?: (stamp: unknown) => SlicedRedo | null;
};

const collabUndo = (editor: LexicalEditor): CollabUndo | undefined =>
  (editor as LexicalEditor & Record<symbol, CollabUndo | undefined>)[COLLAB_UNDO_MANAGER];

const noteDoc = (editor: LexicalEditor): Y.Doc | undefined => {
  const undo = collabUndo(editor);
  return undo?.root?.doc ?? undo?.doc;
};

const noop = () => {};
const quiet = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

/** What a scratch editor's updates add to a doc bound as a note's is: its bytes, and the largest piece one sends as. */
class Measure {
  readonly doc = new Y.Doc();
  largestPiece = 0;
  readonly #stop: () => void;

  constructor(editor: LexicalEditor) {
    const binding = createBinding(editor, quiet, 'root', this.doc, new Map([['root', this.doc]]), excludedPropertiesFor(editor));
    const stopSync = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(binding, quiet, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    });
    const onUpdate = (update: Uint8Array) => {
      for (const piece of splitUpdate(update, PIECE_BYTES)) this.largestPiece = Math.max(this.largestPiece, piece.update.byteLength);
    };
    this.doc.on('update', onUpdate);
    this.#stop = () => {
      stopSync();
      this.doc.off('update', onUpdate);
    };
  }

  /** The bytes the doc holds; the measure ends. */
  end(): number {
    this.#stop();
    const bytes = Y.encodeStateAsUpdate(this.doc).byteLength;
    this.doc.destroy();
    return bytes;
  }
}

const scratchEditor = (nodes: readonly Klass<LexicalNode>[]) => createEditor({
  namespace: 'moss-multi-paste-measure',
  nodes: [...nodes],
  onError: (error) => {
    throw error;
  },
});

/**
 * A doc's bytes as the DocDO holds them: the undo stack keeps deleted content for a redo (an undone 20 MB paste still
 * encodes at 20 MB here), and the DocDO's doc has collected it. Measured on a collected copy when it could matter.
 */
function gcBytes(update: Uint8Array): number {
  if (update.byteLength < STATE_CAP_BYTES / 4) return update.byteLength;
  const copy = new Y.Doc();
  Y.applyUpdate(copy, update);
  const bytes = Y.encodeStateAsUpdate(copy).byteLength;
  copy.destroy();
  return bytes;
}

/**
 * The note's doc and its payload docs, as the DocDO counts them against the cap (A§5.1). The DocDO counts every payload
 * it stores, withheld ones too (a deleted code block's text, kept for an undo), and this tab holds only the ones its
 * tree names, so the payloads count as the larger of the DocDO's last word and what this tab holds.
 */
function heldBytes(editor: LexicalEditor): number | null {
  const bound = noteDoc(editor);
  if (!bound) return null;
  // In Suggest mode the editor writes the fork F; the DocDO counts the body it forks, whose session knows its payloads.
  const doc = forkOf(bound)?.body ?? bound;
  let payloads = 0;
  for (const payload of payloadDocsFor(doc).docs.values()) payloads += Y.encodeStateAsUpdate(payload).byteLength;
  return gcBytes(Y.encodeStateAsUpdate(doc)) + Math.max(payloads, countedPayloadBytes(doc));
}

/** Room under the frame cap for a frame's own header beyond what a piece or payload frame measures. */
const FRAME_SLACK = 64;

/**
 * Below `share` of the cap (a little headroom for what the estimate leaves out; a suggestion stops at the reserve kept
 * for edits); every frame within the frame cap. The figures are a User Timing mark (`moss-paste-admission`), so a
 * refusal can be told apart from a bug.
 */
function fits(editor: LexicalEditor, bytes: number, largestFrame: number, share = 0.97): boolean {
  const held = heldBytes(editor);
  const fit = largestFrame <= CLIENT_FRAME_MAX_BYTES - FRAME_SLACK && (held === null || held + bytes <= STATE_CAP_BYTES * share);
  performance.mark('moss-paste-admission', { detail: { adds: bytes, held, largestFrame, fit } });
  return fit;
}

/** A payload's value as its first frame carries it (registers.ts seedOf): text, or a chart's or sketch's keys. */
export type PayloadSeed = string | ReadonlyMap<string, unknown>;

/** A minted payload id's length (newPayloadId: 128 bits in hex), for the frame header. */
const PROBE_ID = '0'.repeat(32);
/** A compound payload's keys written per step while it is measured: a 30,000-point chart is 90,000 keys. */
const KEYS_PER_STEP = 10_000;

const payloadFrameBytes = (update: Uint8Array): number => encodePayloadFrame(PROBE_ID, PAYLOAD_UPDATE, update).byteLength;

/**
 * Each payload's first frame, as PayloadSync sends it: the seed's one update, whole (only note frames go as pieces).
 * Encoded for real, since a chart's keys encode several times larger than its JSON. Returns their bytes summed and the
 * largest, a step at a time; stops at the first one past `frameCap`, which refuses the paste anyway.
 */
export function* measurePayloads(seeds: readonly PayloadSeed[], frameCap = CLIENT_FRAME_MAX_BYTES): Generator<void, { bytes: number; largest: number }> {
  let bytes = 0;
  let largest = 0;
  for (const seed of seeds) {
    const doc = new Y.Doc();
    let size = 0;
    doc.on('update', (update: Uint8Array) => {
      size += payloadFrameBytes(update);
    });
    if (typeof seed === 'string') {
      if (seed) seedPayload(doc, seed, null);
    } else {
      // In steps of keys: each step's update is a little larger than its share of one update, never smaller.
      const map = payloadMap(doc);
      let step: [string, unknown][] = [];
      const write = () => doc.transact(() => {
        for (const [key, value] of step) map.set(key, value);
      });
      for (const entry of seed) {
        step.push(entry);
        if (step.length < KEYS_PER_STEP) continue;
        write();
        step = [];
        if (size > frameCap) break;
        yield;
      }
      if (step.length > 0 && size <= frameCap) write();
    }
    doc.destroy();
    bytes += size;
    largest = Math.max(largest, size);
    if (largest > frameCap) break;
    yield;
  }
  return { bytes, largest };
}

/** The payload seeds of `nodes` and everything in them, in document order. */
function $payloadSeeds(nodes: readonly LexicalNode[]): PayloadSeed[] {
  const seeds: PayloadSeed[] = [];
  const visit = (node: LexicalNode) => {
    if (isPayloadType(node.getType())) seeds.push(seedOf(node));
    if ($isElementNode(node)) for (let child = node.getFirstChild(); child; child = child.getNextSibling()) visit(child);
  };
  nodes.forEach(visit);
  return seeds;
}

/**
 * A large plain-text paste as the paste plan Lexical's own paste would make of it: a paragraph per line, tabs as tab
 * nodes (@lexical/clipboard's plain-text importer), or with `lineBreaks`, one paragraph whose lines are line breaks
 * (RangeSelection.insertRawText). Its units are built as JSON from Lexical's own serialization of each node kind, so
 * planning makes no Lexical node per line; it then lands, or is refused, like a markdown paste: rehearsed and placed
 * in paced batches, never in one task.
 */
export function planPlainText(nodes: readonly Klass<LexicalNode>[], text: string, lineBreaks = false): PastePlan {
  const parser = scratchEditor(nodes);
  parser.update(() => {
    const filled = $createParagraphNode().append($createTextNode('x'), $createTabNode(), $createLineBreakNode());
    $getRoot().clear().append($createParagraphNode(), filled);
  }, { discrete: true });
  const [empty, filled] = parser.getEditorState().toJSON().root.children as SerializedElementNode[];
  const [textJson, tabJson, breakJson] = filled.children;
  // $cost's measure: one per node, text by its length.
  let cost = 1;
  const line = (into: SerializedLexicalNode[], value: string) => {
    value.split('\t').forEach((part, i) => {
      if (i > 0) {
        into.push({ ...tabJson });
        cost += 1 + 1 / 64;
      }
      if (part) {
        into.push({ ...textJson, text: part } as SerializedLexicalNode);
        cost += 1 + part.length / 64;
      }
    });
  };
  const units: Part[] = [];
  const unit = (children: SerializedLexicalNode[]) => {
    const index = units.length;
    units.push({ json: { ...empty, children } as SerializedElementNode, parent: null, index, children: [], cost, lo: index, hi: index });
    cost = 1;
  };
  const lines = text.split('\n');
  if (lineBreaks) {
    const children: SerializedLexicalNode[] = [];
    lines.forEach((value, i) => {
      if (i > 0) {
        children.push({ ...breakJson });
        cost += 1;
      }
      line(children, value);
    });
    unit(children);
  } else {
    for (const value of lines) {
      const children: SerializedLexicalNode[] = [];
      line(children, value);
      unit(children);
    }
  }
  return { top: units, units, payloads: [] };
}

// ---------- the plan: units ----------

/** A node of the paste: a unit, placed whole, or a list, list item or table too large to be one (a spine). */
export interface Part {
  /** A unit's whole JSON; a spine's without its children. */
  json: SerializedLexicalNode;
  parent: Part | null;
  index: number;
  /** A spine's children; a unit has none. */
  children: Part[];
  cost: number;
  /** The units in it: their first and last index. */
  lo: number;
  hi: number;
}

export interface PastePlan {
  top: Part[];
  units: Part[];
  /** The payload docs (code, HTML, formula, chart and sketch fields) the paste makes, as their first frames carry them. */
  payloads: PayloadSeed[];
}

/** Splittable when too large: the items of a list, a nested list's item, the rows of a table. Rows stay whole. */
const SPINES = new Set(['list', 'listitem', 'table']);
/** About the work of one placed node; text counts by its length. */
export const UNIT_COST = 256;

const isBlock = (node: LexicalNode) => ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();

function $cost(node: LexicalNode): number {
  if ($isElementNode(node)) {
    let cost = 1;
    for (let child = node.getFirstChild(); child; child = child.getNextSibling()) cost += $cost(child);
    return cost;
  }
  return 1 + ($isTextNode(node) || $isDecoratorNode(node) ? node.getTextContentSize() / 64 : 0);
}

/**
 * The paste's top-level `nodes` (read in the editor that parsed them, whose serialization `json` is) as units in
 * document order. A list, nested list or table costing more than `unitCost` is a spine: its children are planned in
 * turn, so a 30,000-item list lands in batches of items.
 */
export function $planPaste(nodes: LexicalNode[], json: SerializedLexicalNode[], unitCost = UNIT_COST): PastePlan {
  const units: Part[] = [];
  const visit = (node: LexicalNode, serialized: SerializedLexicalNode, parent: Part | null, index: number): Part => {
    const part: Part = { json: serialized, parent, index, children: [], cost: 1, lo: units.length, hi: units.length };
    const kids = $isElementNode(node) ? node.getChildren() : [];
    const cost = $cost(node);
    if (cost > unitCost && SPINES.has(node.getType()) && kids.length > 0 && kids.every(isBlock)) {
      const { children, ...own } = serialized as SerializedElementNode;
      part.json = { ...own, children: [] } as SerializedElementNode;
      part.children = kids.map((kid, i) => visit(kid, children[i], part, i));
    } else {
      part.cost = cost;
      units.push(part);
    }
    part.hi = units.length - 1;
    return part;
  };
  const top = nodes.map((node, i) => visit(node, json[i], null, i));
  return { top, units, payloads: $payloadSeeds(nodes) };
}

// ---------- placing the units ----------

const attached = (key: NodeKey | undefined): LexicalNode | null => {
  const node = key === undefined ? null : $getNodeByKey(key);
  return node?.isAttached() ? node : null;
};

/**
 * `node` placed before `target` without moving the selection. Lexical's insertBefore pays getIndexWithinParent() on
 * every call, so placing n blocks before one took O(n²); inserting after the previous sibling does not.
 */
function $placeBefore(target: LexicalNode, node: LexicalNode): void {
  const previous = target.getPreviousSibling();
  if (previous) previous.insertAfter(node, false);
  else target.insertBefore(node, false);
}

/** What a placed part's JSON becomes when its Placer releases it. */
const PLACED: SerializedLexicalNode = { type: 'placed', version: 1 };

/**
 * Places a plan's units in batches, each in an update of its own. The first batch is the first units and the last
 * one, with their lists and tables around them, inserted by the caller (at the caret, as Lexical's paste would, so
 * the paste merges with the text around it the same way). Between them, when they part at the top level, an empty
 * paragraph keeps a list ending the first batch from merging with a list the last unit is in; it goes with the
 * last batch. Each later unit follows the one before it in its list or table, and its lists and tables are made as
 * it needs them.
 */
export class Placer {
  readonly #keys = new Map<Part, NodeKey>();
  /** The paste's top-level lists and tables placed so far: later batches fill them. */
  readonly spines: NodeKey[] = [];
  #next = 0;
  #gap: NodeKey | undefined;
  #done = false;

  /** With `release`, each part's JSON is dropped once placed, so a large paste's plan shrinks as it lands. */
  constructor(readonly plan: PastePlan, readonly release = false) {
    if (plan.units.length === 0) this.#done = true;
  }

  #parse(part: Part): LexicalNode {
    const node = $parseSerializedNode(part.json);
    if (this.release) part.json = PLACED;
    return node;
  }

  get done(): boolean {
    return this.#done;
  }

  /** The first batch: units up to `budget` and the last unit, handed to `insert` as top-level nodes. */
  $first(budget: number, insert: (nodes: LexicalNode[]) => void): void {
    const { units, top } = this.plan;
    const n = units.length;
    if (n === 0) return;
    let k = 0;
    for (let cost = 0; k < n && (k === 0 || cost + units[k].cost <= budget); k += 1) cost += units[k].cost;
    if (k >= n - 1) k = n;
    const wanted = (part: Part) => part.lo < k || part.hi === n - 1;
    let common = k < n ? units[n - 1].parent : null;
    while (common && common.lo > k - 1) common = common.parent;
    const gap = k < n && common === null ? $createParagraphNode() : null;
    const build = (part: Part): LexicalNode => {
      const node = this.#parse(part);
      this.#keys.set(part, node.getKey());
      if (part.parent === null && part.children.length > 0) this.spines.push(node.getKey());
      if ($isElementNode(node)) for (const child of part.children) if (wanted(child)) node.append(build(child));
      return node;
    };
    const nodes: LexicalNode[] = [];
    for (const part of top) {
      if (!wanted(part)) continue;
      if (gap && part.hi === n - 1) nodes.push(gap);
      nodes.push(build(part));
    }
    this.#gap = gap?.getKey();
    this.#next = k;
    insert(nodes);
    if (k === n) this.#done = true;
  }

  /** The next units up to `budget`; the last batch also drops the gap. */
  $next(budget: number): void {
    const { units } = this.plan;
    const last = units.length - 1;
    for (let cost = 0; this.#next < last && (cost === 0 || cost + units[this.#next].cost <= budget); this.#next += 1) {
      cost += units[this.#next].cost;
      this.#place(units[this.#next]);
    }
    if (this.#next < last) return;
    const gap = attached(this.#gap);
    if ($isElementNode(gap) && gap.isEmpty()) gap.remove();
    this.#done = true;
  }

  #place(unit: Part): void {
    let top = unit;
    while (top.parent && !this.#keys.has(top.parent)) top = top.parent;
    const build = (part: Part): LexicalNode => {
      const node = this.#parse(part);
      this.#keys.set(part, node.getKey());
      if (part.parent === null && part.children.length > 0) this.spines.push(node.getKey());
      const child = part.children.find((each) => each.lo <= unit.lo && unit.lo <= each.hi);
      if (child && $isElementNode(node)) node.append(build(child));
      return node;
    };
    const node = build(top);
    const gap = attached(this.#gap);
    const siblings = top.parent ? top.parent.children : this.plan.top;
    if (top.parent === null && gap) {
      $placeBefore(gap, node);
      return;
    }
    const before = top.index > 0 ? attached(this.#keys.get(siblings[top.index - 1])) : null;
    if (before) {
      before.insertAfter(node, false);
      return;
    }
    // The first of its list or table to land after the first batch: before the part the last unit is in.
    const holdsLast = siblings.find((part) => part.hi === this.plan.units.length - 1);
    const after = top.index === 0 && holdsLast ? attached(this.#keys.get(holdsLast)) : null;
    if (after) $placeBefore(after, node);
    else if (gap) $placeBefore(gap, node);
    else $getRoot().append(node);
  }
}

/**
 * Runs `place`, which inserts nodes without moving the selection; a caret at an element offset (between blocks)
 * stays after the same child.
 */
export function $keepElementPoints(place: () => void): void {
  const selection = $getSelection();
  const points = $isRangeSelection(selection) ? [selection.anchor, selection.focus].filter((point) => point.type === 'element') : [];
  const marks = points.map((point) => {
    const parent = point.getNode() as ElementNode;
    return { point, parent, before: point.offset > 0 ? parent.getChildAtIndex(point.offset - 1) : null };
  });
  place();
  for (const { point, parent, before } of marks) {
    if (!parent.isAttached()) continue;
    const offset = before === null ? 0 : before.isAttached() && before.getParent()?.is(parent) ? before.getIndexWithinParent() + 1 : point.offset;
    point.set(parent.getKey(), Math.min(offset, parent.getChildrenSize()), 'element');
  }
}

/** An empty note's content becomes `nodes`, caret at the end. One append per block: a spread of 150,000 overflows. */
export function $replaceEmptyNote(nodes: LexicalNode[]): void {
  $setSelection(null);
  const root = $getRoot();
  root.clear();
  for (const node of nodes) root.append(node);
  root.selectEnd();
}

/**
 * Inserts the fresh top-level `nodes` at `selection` as `insert` (Lexical's) would, in time linear in the blocks.
 * Lexical moves each block after the previous one, and every move pays getIndexWithinParent(), so 100,000 short
 * paragraphs froze the tab. `insert` places the first, second and last blocks, which settles every merge with the
 * text around the caret; the blocks between follow the second, unmoved, with no selection to keep up per block.
 */
export function $insertBlocks(nodes: LexicalNode[], selection: BaseSelection, insert: (nodes: LexicalNode[], selection: BaseSelection) => void): void {
  if (nodes.length <= 3) {
    insert(nodes, selection);
    return;
  }
  const [first, second] = nodes;
  const last = nodes[nodes.length - 1];
  const middle = nodes.slice(2, -1);
  insert([first, second, last], selection);
  const parent = second.isAttached() ? second.getParent() : null;
  if (parent === null) {
    // Nothing placed the second block (a command took the insert): the rest goes before the last, or at the end.
    if (last.isAttached()) for (const node of middle) $placeBefore(last, node);
    else for (const node of middle) $getRoot().append(node);
    return;
  }
  const index = second.getIndexWithinParent();
  let previous = second;
  for (const node of middle) previous = previous.insertAfter(node, false);
  // insertAfter(…, false) leaves element points alone; one past the second block moves down by the blocks added.
  const after = $getSelection();
  if (!$isRangeSelection(after)) return;
  for (const point of [after.anchor, after.focus]) {
    if (point.type === 'element' && point.key === parent.getKey() && point.offset > index) {
      point.set(point.key, point.offset + middle.length, 'element');
    }
  }
}

// ---------- the paste job ----------

/**
 * What one batch's work and layout may take, on the machine it runs on. Each batch also pays a cost that grows with
 * the note, not the batch (laying the note out, diffing the list it lands in, copying the editor state): small
 * batches in a large note spend most of their time on it, so the paste slows and the tab still stalls. A batch fills
 * what the target leaves after that cost, and never less than a third of it.
 */
const TARGET_MS = 700;
/** The first batch, before any is timed: inserting at the caret costs Lexical more per block than the batches after. */
const FIRST_BATCH = 128;
/** Laying out n new list items with values at once takes time quadratic in n (Chromium): batches stay this small. */
const MAX_BATCH = 2_500;
/** A paste of top-level blocks only (no list items or table rows) has no such layout cost. */
const MAX_TOP_BATCH = 20_000;

/**
 * Units per batch, sized from how long the last batch's work and its layout took. Each batch is a User Timing measure
 * named `label` (its units, work, layout and the time since the batch before in `detail`), so a profile or a test can
 * tell a batch from other work.
 */
class Pacer {
  budget = FIRST_BATCH;
  #ended: number | null = null;
  #last: { units: number; work: number } | null = null;

  constructor(readonly label: string, readonly max = MAX_BATCH) {}

  /**
   * Runs a batch of `used` units (`run`, which may return the units it used instead), then lays the note out
   * (`layout`), and sizes the next batch.
   */
  time(used: number, run: () => number | void, layout?: () => void): void {
    const started = performance.now();
    const before = this.#ended === null ? 0 : started - this.#ended;
    const counted = run();
    if (typeof counted === 'number' && counted > 0) used = counted;
    const ran = performance.now();
    layout?.();
    this.#ended = performance.now();
    const work = Math.max(0.001, ran - started);
    const laid = this.#ended - ran;
    performance.measure(this.label, { start: started, detail: { units: used, workMs: Math.round(work), layoutMs: Math.round(laid), beforeMs: Math.round(before) } });
    const room = Math.max(TARGET_MS / 3, TARGET_MS - laid);
    if (this.max !== MAX_TOP_BATCH) {
      // List items and table rows: sized by the whole time (each item can cost time linear in its list).
      this.budget = Math.round(Math.max(FIRST_BATCH, Math.min(this.max, used * 4, room / (work / used))));
      return;
    }
    // Top-level blocks: a batch's work is a cost that grows with the note (the update copying and diffing the root)
    // plus a cost per block. Two batches of different sizes tell them apart; sized by the whole time alone, batches
    // in a large note shrank to FIRST_BATCH and each still paid the note's cost. A batch that cannot learn (the same
    // size twice, or more blocks in no more time) tries twice the blocks.
    const last = this.#last;
    this.#last = { units: used, work };
    let budget = room / (work / used);
    if (last && last.units !== used) {
      const marginal = (work - last.work) / (used - last.units);
      if (marginal > 0) {
        const fixed = Math.min(work, Math.max(0, work - marginal * used));
        // Blocks fill what the target leaves after the note's cost, and at least as long as that cost (to twice the
        // target), so a large note's paste takes few batches rather than many that each pay for the note.
        budget = Math.max(TARGET_MS / 3, TARGET_MS - laid - fixed, Math.min(fixed, TARGET_MS * 2)) / marginal;
      } else if (work + laid < TARGET_MS * 2) {
        budget = used * 2;
      }
    } else if (last && budget <= used && work + laid < TARGET_MS * 2) {
      budget = used * 2;
    }
    // Whatever the estimate, a batch is never sized past three targets at this batch's whole rate: mixed content
    // costs more per block in larger batches, and doubling a 1.2 s batch held the tab 3.4 s (WebKit, CI).
    const ceiling = used * (TARGET_MS * 3) / (work + laid);
    this.budget = Math.round(Math.max(FIRST_BATCH, Math.min(this.max, used * 2, budget, ceiling)));
  }
}

export interface PasteRequest {
  plan: PastePlan;
  /** The node classes of the editor that parsed the plan, for the scratch replay. */
  nodes: readonly Klass<LexicalNode>[];
  /** Puts the caret back where the paste was made; false when it is gone. */
  $restore: () => boolean;
  /** Inserts the first batch's top-level nodes at the caret. */
  $insert: (nodes: LexicalNode[]) => void;
}

/** What interrupts a paste in progress: it lands the rest at once, first. */
const INPUT_EVENTS = ['keydown', 'pointerdown', 'mousedown', 'paste', 'drop', 'cut', 'beforeinput', 'compositionstart'] as const;

const jobs = new WeakMap<LexicalEditor, PasteJob>();

/** A paste, or a paste's redo, landing in batches; any input lands the rest first. */
class PasteJob {
  readonly #steps: Generator<void, void>;
  readonly #stops: (() => void)[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushing = false;
  #ended = false;
  /** The paste's lists and tables go without `dir` while batches fill them (dir-lift.ts). */
  readonly #dir = new DirLift();

  constructor(readonly editor: LexicalEditor, steps: (job: PasteJob) => Generator<void, void>) {
    this.#steps = steps(this);
  }

  /** Landing the rest at once: no more yielding. */
  get flushing(): boolean {
    return this.#flushing;
  }

  start(): void {
    markUnacked(this, true);
    markLanding(this.editor, true);
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, this.flush, true);
      this.#stops.push(() => window.removeEventListener(type, this.flush, true));
    }
    // An undo or redo while the paste lands: keys and clicks land the rest first, outside any update. A command
    // dispatched otherwise runs inside an update, which the rest would join, and the undo's own (historic) changes
    // would then keep that update from reaching the doc: the rest lands and this undo or redo does nothing.
    const landFirst = () => {
      const landing = !this.#ended;
      this.flush();
      return landing;
    };
    this.#stops.push(
      // The pane closing (or the note switching) unmounts the editor: the rest lands while its binding still syncs.
      this.editor.registerRootListener((root) => {
        if (!root) this.flush();
      }),
      this.editor.registerCommand(UNDO_COMMAND, landFirst, COMMAND_PRIORITY_CRITICAL),
      this.editor.registerCommand(REDO_COMMAND, landFirst, COMMAND_PRIORITY_CRITICAL),
    );
    this.#timer = setTimeout(this.#tick, 0);
  }

  /** Lands whatever is left now, in this task. */
  readonly flush = (): void => {
    if (this.#ended || this.#flushing) return;
    this.#flushing = true;
    clearTimeout(this.#timer);
    try {
      while (!this.#steps.next().done) {
        // each step's work is done; no yielding
      }
    } finally {
      this.#end();
    }
  };

  readonly #tick = (): void => {
    this.#timer = undefined;
    let done = true;
    try {
      done = !!this.#steps.next().done;
    } finally {
      if (done) this.#end();
      else this.#timer = setTimeout(this.#tick, 0);
    }
  };

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#timer);
    this.#dir.restore();
    for (const stop of this.#stops.splice(0)) stop();
    if (jobs.get(this.editor) === this) {
      jobs.delete(this.editor);
      // The rest landed inside a pending update (a command's, or the binding's): it is still the paste until it commits.
      const { editor } = this;
      if (editor._updating || editor._pendingEditorState !== null) {
        const stop = editor.registerUpdateListener(() => {
          stop();
          if (!jobs.has(editor)) markLanding(editor, false);
        });
      } else {
        markLanding(editor, false);
      }
    }
    markUnacked(this, false);
  }

  /** Lifts `dir` from the top-level elements holding the paste's lists and tables (dir-lift.ts). */
  liftDir(placer: Placer): void {
    // Inside an update (a flush from a command), the rest lands at once anyway.
    if (placer.spines.length === 0 || this.editor._updating) return;
    this.editor.read(() => {
      for (const key of placer.spines) {
        const top = attached(key)?.getTopLevelElement();
        const dom = top ? this.editor.getElementByKey(top.getKey()) : null;
        if (dom) this.#dir.lift(dom);
      }
    });
  }

  /** Lifts `dir` from every top-level element with many children: a redo's slices fill them (dir-lift.ts). */
  liftLargeDir(): void {
    for (const child of this.editor.getRootElement()?.children ?? []) {
      if (child.childElementCount >= LARGE_CHILDREN) this.#dir.lift(child as HTMLElement);
    }
  }

  restoreDir(): void {
    this.#dir.restore();
  }
}

/** Whether `point` names a node still in the note, at an offset it has. */
function $holds(point: PointType): boolean {
  const node = $getNodeByKey(point.key);
  if (!node?.isAttached()) return false;
  if (point.type === 'text') return $isTextNode(node) && point.offset <= node.getTextContentSize();
  return $isElementNode(node) && point.offset <= node.getChildrenSize();
}

/**
 * Pastes at `selection`, the editor's committed selection, when it still names nodes in the note. The binding moves it
 * with every peer's edit while the paste is checked (it keeps this client's cursor as relative positions), and any
 * input of this client's lands the paste first, so it is where the paste was made. The keys and offsets saved at the
 * paste know nothing of the peers' edits: they would split a peer's text, or delete it with a selected range.
 */
function $selectLive(selection: BaseSelection | null): boolean {
  if ($isRangeSelection(selection)) {
    if (!$holds(selection.anchor) || !$holds(selection.focus)) return false;
  } else if ($isNodeSelection(selection)) {
    const keys = [...selection._nodes];
    if (keys.length === 0 || !keys.every((key) => $getNodeByKey(key)?.isAttached())) return false;
  } else {
    return false;
  }
  $setSelection(selection.clone());
  return true;
}

/**
 * The scratch replay: the bytes the paste adds to the note and its payload docs, and its largest frame. Its own
 * function, so the scratch editor and doc are garbage once it returns, not held while the paste lands.
 */
function* rehearse(request: PasteRequest, max: number): Generator<void, { bytes: number; largestFrame: number }> {
  const { plan } = request;
  const pacer = new Pacer('moss-paste-rehearsal', max);
  const scratch = scratchEditor(request.nodes);
  const measure = new Measure(scratch);
  const rehearsal = new Placer(plan);
  const step = (budget: number, place: (budget: number) => void) =>
    pacer.time(budget, () => scratch.update(() => place(budget), { discrete: true }));
  step(pacer.budget, (budget) => rehearsal.$first(budget, $replaceEmptyNote));
  while (!rehearsal.done) {
    yield;
    step(pacer.budget, (budget) => rehearsal.$next(budget));
  }
  const noteBytes = measure.end();
  const payloads = yield* measurePayloads(plan.payloads);
  return { bytes: noteBytes + payloads.bytes, largestFrame: Math.max(measure.largestPiece, payloads.largest) };
}

/** Suggest mode refuses a paste whole, with the cap it would pass. */
const SUGGEST_PASTE_REFUSED: Partial<Record<SuggestRefusal, string>> & { default: string } = {
  default: 'This paste is too large for one suggestion, so none of it was added.',
  'open-cap': 'You have too many open suggestions on this note, so none of the paste was added.',
  'record-closed': 'Suggesting stopped before the paste went in, so none of it was added.',
  lease: 'Suggesting stopped before the paste went in, so none of it was added.',
};

/** Suggest mode's routing of a selection a whole paste replaces (routing.ts). */
export interface SuggestPasteRoute {
  /** The body items the selection would strike, read without striking them. */
  $targets(): IdSpan[];
  /** Strikes the selection (the author's own text in it goes natively), the caret at its end. */
  $route(): void;
}

const suggestRoutes = new WeakMap<LexicalEditor, SuggestPasteRoute>();

export function registerSuggestPasteRoute(editor: LexicalEditor, route: SuggestPasteRoute): () => void {
  suggestRoutes.set(editor, route);
  return () => {
    if (suggestRoutes.get(editor) === route) suggestRoutes.delete(editor);
  };
}

/** Lands `request`: its scratch replay, then its batches or its refusal. */
function* landPaste(job: PasteJob, request: PasteRequest): Generator<void, void> {
  const { editor } = job;
  const { plan } = request;
  const max = plan.units.every((unit) => unit.parent === null) ? MAX_TOP_BATCH : MAX_BATCH;

  // 1. The scratch replay: what the paste adds, refused whole when past the cap or a frame past the frame cap.
  const { bytes, largestFrame } = yield* rehearse(request, max);
  if (!fits(editor, bytes, largestFrame)) {
    refuseInput(WRITE_REFUSED['doc-cap']);
    return;
  }
  yield;
  // Suggest mode: the paste is one suggestion's edit, never batched (landSuggested).
  const doc = noteDoc(editor);
  const fork = doc ? forkOf(doc) : undefined;
  if (fork) {
    landSuggested(editor, request, fork, bytes);
    return;
  }

  // 2. The paste itself: the first batch at the caret, then the rest, all one undo step.
  const undo = collabUndo(editor);
  undo?.stopCapturing();
  const placer = new Placer(plan, true);
  // Laid out after each batch, in it: laid out later, several batches' list items would go at once (MAX_BATCH).
  const layout = () => {
    void editor.getRootElement()?.offsetHeight;
    runBatchGeometry(editor);
  };
  // Paced afresh: the live editor also renders and lays out each batch.
  const pacing = new Pacer('moss-paste-batch', max);
  const first = pacing.budget;
  // A pending update (a peer's or a derived write, tagged as collaboration) would take a batch into it, and an update
  // so tagged never reaches the doc: each batch commits it first, on its own.
  const settle = () => editor.read(noop);
  settle();
  const live = editor.getEditorState()._selection;
  pacing.time(first, () => editor.update(() => {
    if (!$selectLive(live) && !request.$restore()) $getRoot().selectEnd();
    placer.$first(first, request.$insert);
  }, { discrete: true }), layout);
  let batches = 1;
  while (!placer.done) {
    job.liftDir(placer);
    batches += 1;
    // Without a step to hold open (no collaborative undo), the rest goes in now.
    if (undo?.hold && !job.flushing) yield;
    // Every later batch joins the paste's undo step (BodyUndo.hold), released once its update has committed.
    if (!editor._updating) settle();
    const release = undo?.hold?.();
    const nested = editor._updating;
    const budget = pacing.budget;
    pacing.time(budget, () => editor.update(() => $keepElementPoints(() => placer.$next(budget)), { discrete: true, onUpdate: release }), layout);
    if (!nested) release?.();
  }
  job.restoreDir();
  undo?.stopCapturing();
  // Its redo lands in slices too: the step is stamped as a paste's (redoInSlices). The stamp is a token, not the
  // request: the step lives as long as the undo stack, and the plan (every unit's JSON) need not.
  const step = batches > 1 ? undo?.undoStack?.at(-1) : undefined;
  if (step) {
    const stamp = {};
    step.stamp = stamp;
    pasted.set(stamp, max);
  }
}

const utf8 = new TextEncoder();
/** A node's own properties as the binding writes them (its JSON, children apart), plus an item header. */
const nodeBytes = (node: LexicalNode, text?: string): number => {
  const json = JSON.stringify({ ...node.exportJSON(), ...(text === undefined ? {} : { text }) });
  return utf8.encode(json).byteLength + 32;
};
const treeBytes = (node: LexicalNode): number =>
  nodeBytes(node) + ($isElementNode(node) ? node.getChildren().reduce((sum, child) => sum + treeBytes(child), 0) : 0);

/**
 * What the paste re-creates under the suggester's client besides the clipboard: a split moves the rest of the block
 * after the selection into a new element, and the binding writes it as new items, the same bytes again. Counted to the
 * end of the selection's top-level block (its following siblings at every level), with the elements that hold it.
 */
function $splitBytes(selection: BaseSelection | null): number {
  if (!$isRangeSelection(selection)) return 0;
  const end = selection.isBackward() ? selection.anchor : selection.focus;
  const node = end.getNode();
  if ($isRootOrShadowRoot(node)) return 0;
  let bytes = 0;
  if ($isTextNode(node)) bytes += nodeBytes(node, node.getTextContent().slice(end.offset));
  else if ($isElementNode(node)) bytes += nodeBytes(node) + node.getChildren().slice(end.offset).reduce((sum, child) => sum + treeBytes(child), 0);
  // Up to the block that sits in the root (or a table cell): its siblings stay where they are.
  for (let at: LexicalNode = node, parent = at.getParent(); parent && !$isRootOrShadowRoot(parent); at = parent, parent = at.getParent()) {
    for (let next = at.getNextSibling(); next; next = next.getNextSibling()) bytes += treeBytes(next);
    bytes += nodeBytes(parent);
  }
  return bytes;
}

/**
 * A paste in Suggest mode: admitted against every suggestion cap with the strike of the selection it replaces, before
 * anything changes, then the strike and the whole paste in one update (one transaction, one op, one undo step), or
 * refused whole with nothing changed, the selection kept. Batches would each be an op the DocDO could refuse alone.
 */
function landSuggested(editor: LexicalEditor, request: PasteRequest, fork: ForkView, bytes: number): void {
  const route = suggestRoutes.get(editor);
  const undo = collabUndo(editor);
  const outcome: { refusal: SuggestRefusal | null } = { refusal: null };
  // A pending update (a peer's) would take the paste into it, and an update so tagged never reaches the doc.
  if (!editor._updating) editor.read(noop);
  const live = editor.getEditorState()._selection;
  undo?.stopCapturing();
  editor.update(() => {
    if (!$selectLive(live) && !request.$restore()) $getRoot().selectEnd();
    // Inside the update: a flush from a command's update queues this one.
    // The blocks it spans: an older open record of the author's it builds on merges into its record.
    const selection = $getSelection();
    const tops = $isRangeSelection(selection) ? [selection.anchor, selection.focus].map((point) => point.getNode().getTopLevelElement()?.getIndexWithinParent() ?? -1) : [-1];
    const adds = bytes + $splitBytes(selection);
    if (!fits(editor, adds, 0, SUGGEST_LIMITS.reserveShare)) {
      outcome.refusal = 'doc-cap';
      refuseInput(WRITE_REFUSED['doc-cap']);
      return;
    }
    outcome.refusal = fork.admit(adds, route?.$targets(), { from: Math.min(...tops), to: Math.max(...tops) });
    if (outcome.refusal) {
      refuseInput(SUGGEST_PASTE_REFUSED[outcome.refusal] ?? SUGGEST_PASTE_REFUSED.default);
      return;
    }
    route?.$route();
    new Placer(request.plan, true).$first(Number.POSITIVE_INFINITY, request.$insert);
  }, { discrete: true });
  undo?.stopCapturing();
  if (outcome.refusal || editor._updating) return;
  void editor.getRootElement()?.offsetHeight;
  runBatchGeometry(editor);
}

/** The steps of pastes that landed in batches, by the token each is stamped with, and the batch cap they paced with. */
const pasted = new WeakMap<object, number>();
const redoing = new WeakSet<LexicalEditor>();
/**
 * A redo slice's bytes, about: as much as a batch of MAX_TOP_BATCH short blocks, so the pacer sizes slices and few pay
 * the note's cost (capped at 256 KiB, a 40,000-paragraph redo took over 100 slices). The outbox sends it in pieces.
 */
const REDO_SLICE_BYTES = 8 * 1024 * 1024;

/** The redo of a paste that landed in batches, a slice at a time, the main thread free between slices. */
function* redoSlices(job: PasteJob, slices: SlicedRedo, max: number): Generator<void, void> {
  const { editor } = job;
  const pacing = new Pacer('moss-paste-redo', max);
  const layout = () => {
    void editor.getRootElement()?.offsetHeight;
    runBatchGeometry(editor);
  };
  // Commits the binding's update for a slice in this task, so its time and layout count in the slice's.
  const settle = () => {
    if (!editor._updating) editor.read(noop);
  };
  try {
    while (!slices.done) {
      if (!editor._updating) job.liftLargeDir();
      const budget = pacing.budget;
      pacing.time(budget, () => {
        const blocks = slices.next(budget, REDO_SLICE_BYTES);
        settle();
        return blocks;
      }, layout);
      if (!slices.done && !job.flushing) yield;
    }
  } finally {
    slices.finish();
    settle();
    job.restoreDir();
  }
}

/**
 * Redo of a paste that landed in batches redoes its undo step in slices (BodyUndo.redoInSlices): Yjs would restore it
 * in one transaction, and Lexical would place and lay it all out at once, holding the tab as long as one unbatched
 * paste did. Each slice is a Yjs redo, so the steps after it in the redo chain still redo, and it lands where the
 * paste was, wherever peers' edits have moved that.
 */
function $redoInSlices(editor: LexicalEditor): boolean {
  // A paste or a redo still landing lands first.
  jobs.get(editor)?.flush();
  const undo = collabUndo(editor);
  const stamp = undo?.redone?.at(-1)?.stamp;
  const max = typeof stamp === 'object' && stamp !== null ? pasted.get(stamp) : undefined;
  if (max === undefined || !undo?.redoInSlices) return false;
  // Suggest mode redoes it in one transaction, one op the DocDO takes or refuses whole: a refusal between slices would
  // close F, and the slices after it would be neither saved nor offered back.
  const doc = noteDoc(editor);
  if (doc && forkOf(doc)) return false;
  const slices = undo.redoInSlices(stamp);
  if (!slices) return false;
  const job = new PasteJob(editor, (each) => redoSlices(each, slices, max));
  jobs.set(editor, job);
  job.start();
  return true;
}

/** Each editor's test of whether its paste handler lands a paste through pasteLarge (the MarkdownEditor seam's). */
const wholePastes = new WeakMap<LexicalEditor, (event: unknown) => boolean>();

export function registerWholePaste(editor: LexicalEditor, takes: (event: unknown) => boolean): () => void {
  wholePastes.set(editor, takes);
  return () => {
    if (wholePastes.get(editor) === takes) wholePastes.delete(editor);
  };
}

/** Whether `editor`'s paste handler lands `event` through pasteLarge. */
export const takesWholePaste = (editor: LexicalEditor, event: unknown): boolean => wholePastes.get(editor)?.(event) ?? false;

/** Lands `request` in batches, after its scratch replay fits; a paste still landing in `editor` lands first. */
export function pasteLarge(editor: LexicalEditor, request: PasteRequest): void {
  jobs.get(editor)?.flush();
  if (!redoing.has(editor)) {
    redoing.add(editor);
    editor.registerCommand(REDO_COMMAND, () => $redoInSlices(editor), COMMAND_PRIORITY_CRITICAL);
  }
  if (request.plan.units.length === 0) return;
  const job = new PasteJob(editor, (each) => landPaste(each, request));
  jobs.set(editor, job);
  job.start();
}
