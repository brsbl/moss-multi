// T3.S6 (DEVIATIONS 22): a large paste lands whole, or is refused whole before anything of it is applied. Moss at
// the pin split the text into 12,000-character chunks and dropped every chunk after the first. Here the paste is
// parsed once, off the live editor, into units: whole blocks, or the items and rows of a list or table too large to
// go in at once. It is first replayed on a scratch editor bound to a scratch doc, a batch at a time, which gives the
// bytes it adds and its largest indivisible piece; past the note's cap or the frame cap it is refused, visibly. Then
// it lands in batches of units, the main thread free between them, all one undo step. Any input in the meantime (a
// key, a click, another paste, an undo, the pane closing) first lands the rest at once, so nothing is left pending.
import { createBinding, syncLexicalUpdateToYjs, type Provider } from '@lexical/yjs';
import { CLIENT_FRAME_MAX_BYTES, STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { isPayloadType, payloadDocsFor } from '@moss-multi/sync/payload-docs';
import { splitUpdate } from '@moss-multi/sync/update-pieces';
import {
  $createParagraphNode, $createTabNode, $getNodeByKey, $getRoot, $getSelection, $isDecoratorNode, $isElementNode,
  $isRangeSelection, $isTextNode, $parseSerializedNode, $setSelection, COMMAND_PRIORITY_CRITICAL, createEditor,
  REDO_COMMAND, tokenizeRawText, UNDO_COMMAND, type BaseSelection, type ElementNode, type Klass, type LexicalEditor,
  type LexicalNode, type NodeKey, type RangeSelection, type SerializedElementNode, type SerializedLexicalNode,
} from 'lexical';
import * as Y from 'yjs';
import { PIECE_BYTES } from './collab/outbox.ts';
import { WRITE_REFUSED } from './collab/doc-session.ts';
import { markLanding } from './collab/landing.ts';
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

const utf8 = (text: string): number => new TextEncoder().encode(text).byteLength;

/** The note's doc and every payload doc it holds, as the DocDO counts them against the cap (A§5.1). */
function heldBytes(editor: LexicalEditor): number | null {
  const doc = noteDoc(editor);
  if (!doc) return null;
  let bytes = Y.encodeStateAsUpdate(doc).byteLength;
  for (const payload of payloadDocsFor(doc).docs.values()) bytes += Y.encodeStateAsUpdate(payload).byteLength;
  return bytes;
}

/** Below the cap with a little headroom for what the estimate leaves out; a single piece within the frame cap. */
function fits(editor: LexicalEditor, bytes: number, largestPiece: number): boolean {
  const held = heldBytes(editor);
  if (largestPiece > CLIENT_FRAME_MAX_BYTES) return false;
  return held === null || held + bytes <= STATE_CAP_BYTES * 0.97;
}

/**
 * A plain-text paste as Lexical's own paste inserts it, a paragraph per line, refused whole when it would take the
 * note past its cap or hold a line too long for one frame. Large plain text that is not markdown takes this path.
 */
export function refusedPlainText(editor: LexicalEditor, text: string): boolean {
  const scratch = scratchEditor([...editor._nodes.values()].map((entry) => entry.klass));
  const measure = new Measure(scratch);
  scratch.update(() => {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    paragraph.select();
    // Lexical's plain-text importer (@lexical/clipboard): a paragraph per line break.
    const at = (run: (selection: RangeSelection) => void) => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) run(selection);
    };
    tokenizeRawText(text, {
      linebreak: () => at((selection) => selection.insertParagraph()),
      tab: () => at((selection) => selection.insertNodes([$createTabNode()])),
      text: (part) => at((selection) => selection.insertText(part)),
    });
  }, { discrete: true });
  const largest = measure.largestPiece;
  if (fits(editor, measure.end(), largest)) return false;
  refuseInput(WRITE_REFUSED['doc-cap']);
  return true;
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
  /** Bytes of payload docs (code, HTML, formula, chart and sketch fields) the paste makes, and the largest one. */
  payloadBytes: number;
  largestPayload: number;
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

function payloadsOf(json: SerializedLexicalNode, found: (bytes: number) => void): void {
  if (isPayloadType(json.type)) found(utf8(JSON.stringify(json)) + 64);
  for (const child of (json as Partial<SerializedElementNode>).children ?? []) payloadsOf(child, found);
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
  let payloadBytes = 0;
  let largestPayload = 0;
  for (const unit of units) {
    payloadsOf(unit.json, (bytes) => {
      payloadBytes += bytes;
      largestPayload = Math.max(largestPayload, bytes);
    });
  }
  return { top, units, payloadBytes, largestPayload };
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
  #next = 0;
  #gap: NodeKey | undefined;
  #done = false;

  constructor(readonly plan: PastePlan) {
    if (plan.units.length === 0) this.#done = true;
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
      const node = $parseSerializedNode(part.json);
      this.#keys.set(part, node.getKey());
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
      const node = $parseSerializedNode(part.json);
      this.#keys.set(part, node.getKey());
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

/**
 * Units per batch, sized from how long the last batch's work and its layout took. Each batch is a User Timing measure
 * named `label` (its units, work and layout in `detail`), so a profile or a test can tell a batch from other work.
 */
class Pacer {
  budget = FIRST_BATCH;

  constructor(readonly label: string) {}

  /** Runs a batch of `used` units (`run`), then lays the note out (`layout`), and sizes the next batch. */
  time(used: number, run: () => void, layout?: () => void): void {
    const started = performance.now();
    run();
    const ran = performance.now();
    layout?.();
    const perUnit = Math.max(0.001, ran - started) / used;
    const fixed = performance.now() - ran;
    performance.measure(this.label, { start: started, detail: { units: used, workMs: Math.round(ran - started), layoutMs: Math.round(fixed) } });
    const room = Math.max(TARGET_MS / 3, TARGET_MS - fixed);
    this.budget = Math.round(Math.max(FIRST_BATCH, Math.min(MAX_BATCH, used * 4, room / perUnit)));
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
  /** Runs once the last batch is in. */
  $landed?: () => void;
}

/** What interrupts a paste in progress: it lands the rest at once, first. */
const INPUT_EVENTS = ['keydown', 'pointerdown', 'mousedown', 'paste', 'drop', 'cut', 'beforeinput', 'compositionstart'] as const;

const jobs = new WeakMap<LexicalEditor, PasteJob>();

class PasteJob {
  readonly #steps: Generator<void, void>;
  readonly #stops: (() => void)[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushing = false;
  #ended = false;

  constructor(readonly editor: LexicalEditor, readonly request: PasteRequest) {
    this.#steps = this.#run();
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
    for (const stop of this.#stops.splice(0)) stop();
    if (jobs.get(this.editor) === this) {
      jobs.delete(this.editor);
      markLanding(this.editor, false);
    }
    markUnacked(this, false);
  }

  *#run(): Generator<void, void> {
    const { editor, request } = this;
    const { plan } = request;
    const pacer = new Pacer('moss-paste-rehearsal');

    // 1. The scratch replay: what the paste adds to the note, and its largest piece.
    const scratch = scratchEditor(request.nodes);
    const measure = new Measure(scratch);
    const rehearsal = new Placer(plan);
    const rehearse = (budget: number, place: (budget: number) => void) =>
      pacer.time(budget, () => scratch.update(() => place(budget), { discrete: true }));
    rehearse(pacer.budget, (budget) => rehearsal.$first(budget, $replaceEmptyNote));
    while (!rehearsal.done) {
      yield;
      rehearse(pacer.budget, (budget) => rehearsal.$next(budget));
    }
    const largest = Math.max(measure.largestPiece, plan.largestPayload);
    if (!fits(editor, measure.end() + plan.payloadBytes, largest)) {
      refuseInput(WRITE_REFUSED['doc-cap']);
      return;
    }
    yield;

    // 2. The paste itself: the first batch at the caret, then the rest, all one undo step.
    const undo = collabUndo(editor);
    undo?.stopCapturing();
    const placer = new Placer(plan);
    // Laid out after each batch, in it: laid out later, several batches' list items would go at once (MAX_BATCH).
    const layout = () => void editor.getRootElement()?.offsetHeight;
    // Paced afresh: the live editor also renders and lays out each batch.
    const pacing = new Pacer('moss-paste-batch');
    const first = pacing.budget;
    // A pending update (a peer's or a derived write, tagged as collaboration) would take a batch into it, and an update
    // so tagged never reaches the doc: each batch commits it first, on its own.
    const settle = () => editor.read(noop);
    settle();
    const made: { spot: Spot | null } = { spot: null };
    pacing.time(first, () => editor.update(() => {
      if (!request.$restore()) $getRoot().selectEnd();
      made.spot = $spot();
      placer.$first(first, request.$insert);
    }, { discrete: true }), layout);
    let batches = 1;
    while (!placer.done) {
      batches += 1;
      // Without a step to hold open (no collaborative undo), the rest goes in now.
      if (undo?.hold && !this.#flushing) yield;
      // Every later batch joins the paste's undo step (BodyUndo.hold), released once its update has committed.
      if (!editor._updating) settle();
      const release = undo?.hold?.();
      const nested = editor._updating;
      const budget = pacing.budget;
      pacing.time(budget, () => editor.update(() => $keepElementPoints(() => placer.$next(budget)), { discrete: true, onUpdate: release }), layout);
      if (!nested) release?.();
    }
    undo?.stopCapturing();
    if (request.$landed) editor.update(request.$landed, { discrete: true });
    // Its redo lands in batches too: the step is stamped with the paste, which a redo then pastes again.
    const step = batches > 1 && made.spot ? undo?.undoStack?.at(-1) : undefined;
    if (step && made.spot) {
      step.stamp = request;
      pasted.set(request, made.spot);
    }
  }
}

/** Where a paste was made, as undo leaves it: the top-level block holding the caret, and the caret's text offset in it. */
interface Spot {
  index: number;
  chars: number;
}

/** The collapsed caret as a Spot; null for a selection a Spot cannot hold. */
function $spot(): Spot | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const point = selection.anchor;
  const node = point.getNode();
  const top = node.getTopLevelElement() ?? (node.getParent() === null ? null : node);
  if (top === null || !$isElementNode(top)) return null;
  let chars = 0;
  if (point.type === 'text') {
    for (const text of top.getAllTextNodes()) {
      if (text.is(node)) return { index: top.getIndexWithinParent(), chars: chars + point.offset };
      chars += text.getTextContentSize();
    }
    return null;
  }
  if (!node.is(top) || point.offset !== 0) return null;
  return { index: top.getIndexWithinParent(), chars: 0 };
}

/** Puts the caret at `spot`; false when the note no longer has its block. */
function $toSpot(spot: Spot): boolean {
  const top = $getRoot().getChildAtIndex(spot.index);
  if (!$isElementNode(top)) return false;
  let chars = spot.chars;
  for (const text of top.getAllTextNodes()) {
    const size = text.getTextContentSize();
    if (chars <= size) {
      text.select(chars, chars);
      return true;
    }
    chars -= size;
  }
  if (chars > 0) return false;
  top.selectStart();
  return true;
}

/** The pastes that landed in batches, by the request their undo steps are stamped with, and where each was made. */
const pasted = new WeakMap<object, Spot>();
const redoing = new WeakSet<LexicalEditor>();

/**
 * Redo of a paste that landed in batches pastes it again, in batches, where it was made:
 * Yjs would redo it in one transaction, and Lexical would place and lay it all out at once, holding the tab for as
 * long as one unbatched paste did. The new paste, like any new edit, ends the redo chain.
 */
function $redoInBatches(editor: LexicalEditor): boolean {
  const undo = collabUndo(editor);
  const top = undo?.redone?.at(-1);
  const spot = top && typeof top.stamp === 'object' && top.stamp !== null ? pasted.get(top.stamp) : undefined;
  if (!undo?.redone || !top || !spot) return false;
  const request = top.stamp as PasteRequest;
  undo.redone.pop();
  // As a Yjs redo would, the caret stays where it is rather than following the paste.
  const before = $getSelection()?.clone() ?? null;
  const $landed = () => {
    if (!$isRangeSelection(before)) return;
    const held = (point: RangeSelection['anchor']) => {
      const node = $getNodeByKey(point.key);
      if (!node?.isAttached()) return false;
      if (point.type === 'text') return $isTextNode(node) && point.offset <= node.getTextContentSize();
      return $isElementNode(node) && point.offset <= node.getChildrenSize();
    };
    if (held(before.anchor) && held(before.focus)) $setSelection(before);
  };
  pasteLarge(editor, { ...request, $restore: () => $toSpot(spot), $landed });
  return true;
}

/** Lands `request` in batches, after its scratch replay fits; a paste still landing in `editor` lands first. */
export function pasteLarge(editor: LexicalEditor, request: PasteRequest): void {
  jobs.get(editor)?.flush();
  if (!redoing.has(editor)) {
    redoing.add(editor);
    editor.registerCommand(REDO_COMMAND, () => $redoInBatches(editor), COMMAND_PRIORITY_CRITICAL);
  }
  if (request.plan.units.length === 0) return;
  const job = new PasteJob(editor, request);
  jobs.set(editor, job);
  job.start();
}
