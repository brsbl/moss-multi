import { $getEditor, $getNodeByKey, $getRoot, $isElementNode, COLLABORATION_TAG, type LexicalEditor, type LexicalNode } from 'lexical';
import * as Y from 'yjs';
import { diffText } from '@moss-multi/core/text-diff';

export const REGISTER_LOCAL_ORIGIN = Symbol('moss-multi:register-local');
const REGISTER_INIT = Symbol('moss-multi:register-init');
/** Text payloads: one `Y.Text` per node (A§10.10). */
export const REGISTER_FIELDS: Readonly<Record<string, string>> = {
  'code-block': '__code', 'html-block': '__rawHtml', formula: '__formula',
};

type Fields = Record<string, unknown>;
/** What a codec reads: a `Map` of encoded keys, or the register's `Y.Map` itself. */
interface Entries { get(key: string): unknown; has(key: string): boolean; keys(): IterableIterator<string>; entries(): IterableIterator<[string, unknown]> }
/**
 * A compound payload as one `Y.Map` of independent keys, so concurrent edits to different keys both land. `ref`, an
 * encoding of the value `fields` was derived from (or the register itself), lets array elements keep their identity.
 */
interface MapCodec {
  fields: readonly string[];
  encode(fields: Fields, ref?: Entries): Map<string, unknown>;
  decode(entries: Entries): Fields;
  /** Structural keys the register lacks although its value implies them; a write restores them. */
  implied?(entries: Entries): Set<string>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a).filter(key => a[key] !== undefined);
    return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length && keys.every(key => sameValue(a[key], b[key]));
  }
  return false;
}

const segment = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const unsegment = (seg: string) => seg.replace(/~1/g, '/').replace(/~0/g, '~');

/** Order-preserving pairs of equal elements of `prev[i0, i1)` and `next[j0, j1)`, by longest common subsequence. */
function equalPairs(prev: readonly unknown[], next: readonly unknown[], i0: number, i1: number, j0: number, j1: number): [number, number][] {
  const head: [number, number][] = [];
  const tail: [number, number][] = [];
  while (i0 < i1 && j0 < j1 && sameValue(prev[i0], next[j0])) head.push([i0++, j0++]);
  while (i0 < i1 && j0 < j1 && sameValue(prev[i1 - 1], next[j1 - 1])) tail.unshift([--i1, --j1]);
  const n = i1 - i0;
  const m = j1 - j0;
  // A rewrite too large to compare cell by cell keeps only its unchanged ends.
  if (n * m > ALIGN_LIMIT) return [...head, ...tail];
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = sameValue(prev[i0 + i], next[j0 + j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (lcs[i][j] === lcs[i + 1][j + 1] + 1 && sameValue(prev[i0 + i], next[j0 + j])) pairs.push([i0 + i++, j0 + j++]);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return [...head, ...pairs, ...tail];
}
const ALIGN_LIMIT = 100_000;

/** Fills `match` (next index -> prev index, -1 unmatched) with equal pairs inside each gap its existing pairs leave. */
function matchEqualInGaps(prev: readonly unknown[], next: readonly unknown[], match: number[]): void {
  let i0 = 0;
  let j0 = 0;
  for (let j = 0; j <= next.length; j++) {
    if (j < next.length && match[j] < 0) continue;
    const i1 = j < next.length ? match[j] : prev.length;
    if (j > j0 && i1 > i0) for (const [i, k] of equalPairs(prev, next, i0, i1, j0, j)) match[k] = i;
    i0 = i1 + 1;
    j0 = j + 1;
  }
}

function leaves(value: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((element, index) => leaves(element, `${path}/${index}`, out));
  else if (isPlainObject(value)) for (const key of Object.keys(value)) leaves(value[key], `${path}/${segment(key)}`, out);
  else out.set(path, value);
  return out;
}

/**
 * Pairs a gap's elements by what they still share: in order when the gap kept its length (edited in place),
 * otherwise by the most equal leaves, so a deleted element never hands its identity to an edited neighbour.
 */
function pairGap(prev: readonly unknown[], next: readonly unknown[], i0: number, i1: number, j0: number, j1: number, match: number[]): void {
  const n = i1 - i0;
  const m = j1 - j0;
  if (n === m) {
    for (let k = 0; k < n; k++) match[j0 + k] = i0 + k;
    return;
  }
  if (!n || !m || n * m > ALIGN_LIMIT) return;
  const prevLeaves = prev.slice(i0, i1).map(value => leaves(value));
  const nextLeaves = next.slice(j0, j1).map(value => leaves(value));
  const shared = (i: number, j: number) => {
    let count = 0;
    for (const [path, leaf] of nextLeaves[j]) if (prevLeaves[i].has(path) && sameValue(prevLeaves[i].get(path), leaf)) count++;
    return count;
  };
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const score: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => shared(i, j)));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], score[i][j] > 0 ? best[i + 1][j + 1] + score[i][j] : 0);
    }
  }
  for (let i = 0, j = 0; i < n && j < m;) {
    if (score[i][j] > 0 && best[i][j] === best[i + 1][j + 1] + score[i][j]) match[j0 + j++] = i0 + i++;
    else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  }
}

/**
 * For each element of `next`, the index of the element of `prev` it continues, or -1 for a new one: equal elements
 * pair first, then the elements between two pairs by `pairGap`.
 */
export function alignElements(prev: readonly unknown[], next: readonly unknown[]): number[] {
  const match = new Array<number>(next.length).fill(-1);
  const pairs = equalPairs(prev, next, 0, prev.length, 0, next.length);
  for (const [i, j] of pairs) match[j] = i;
  let i0 = 0;
  let j0 = 0;
  for (const [i1, j1] of [...pairs, [prev.length, next.length] as [number, number]]) {
    pairGap(prev, next, i0, i1, j0, j1, match);
    i0 = i1 + 1;
    j0 = j1 + 1;
  }
  return match;
}

/**
 * `chart.__config` as JSON-pointer keys: `#k<path>` holds an object's key order and `=<path>` a leaf. An array is
 * `#a<path>` plus one id per element: `@<path>/<id>` holds its position and `<path>/<id>` its value, so concurrent edits
 * to different data points, and concurrent appends, all land. Order lists are last-writer-wins, so a key missing from
 * its object's list still renders, after the listed ones; an element a peer deleted stays deleted.
 */
const chartCodec: MapCodec = {
  fields: ['__config'],
  encode(fields, ref) {
    const out = new Map<string, unknown>();
    let refIndex: ChartIndex | undefined;
    const indexOfRef = () => (refIndex ??= chartIndex(ref!));
    const walk = (value: unknown, path: string) => {
      if (isPlainObject(value)) {
        const keys = Object.keys(value).filter(key => value[key] !== undefined);
        out.set(`#k${path}`, keys.map(segment));
        for (const key of keys) walk(value[key], `${path}/${segment(key)}`);
      } else if (Array.isArray(value)) {
        out.set(`#a${path}`, true);
        const slots = elementSlots(value, path, ref, indexOfRef);
        value.forEach((element, index) => {
          out.set(`@${path}/${slots[index].id}`, slots[index].at);
          walk(element, `${path}/${slots[index].id}`);
        });
      } else if (value !== undefined) {
        out.set(`=${path}`, clone(value));
      }
    };
    if (fields.__config !== undefined) walk(fields.__config, '');
    return out;
  },
  decode(entries) {
    if (!entries.has('#k')) return { __config: undefined };
    return { __config: chartValue(entries, chartIndex(entries), '') };
  },
  implied(entries) {
    const index = chartIndex(entries);
    const out = new Set<string>();
    for (const path of index.keys()) if (!entries.has(`#a${path}`) && isChartArray(entries, index, path)) out.add(`#a${path}`);
    return out;
  },
};

type ChartIndex = Map<string, Set<string>>;
interface Slot { id: string; at: number }
/** Each path's child segments, from every key that names it or a descendant. */
function chartIndex(entries: Entries): ChartIndex {
  const children: ChartIndex = new Map();
  for (const key of entries.keys()) {
    let path = key.startsWith('#k') || key.startsWith('#a') ? key.slice(2) : key.startsWith('=') || key.startsWith('@') ? key.slice(1) : '';
    while (path) {
      const cut = path.lastIndexOf('/');
      const parent = path.slice(0, cut);
      const segs = children.get(parent) ?? new Set();
      if (segs.has(path.slice(cut + 1))) break;
      children.set(parent, segs.add(path.slice(cut + 1)));
      path = parent;
    }
  }
  return children;
}
/**
 * An array is present while its marker is, or while it still has a positioned element: the marker belongs to whoever
 * created the array, and their undo must not take the elements a peer added (or created alongside) with it.
 */
function isChartArray(entries: Entries, index: ChartIndex, path: string): boolean {
  if (entries.has(`#a${path}`)) return true;
  if (entries.has(`#k${path}`) || entries.has(`=${path}`)) return false;
  for (const id of index.get(path) ?? []) if (typeof entries.get(`@${path}/${id}`) === 'number') return true;
  return false;
}
/** An array's elements in order: those with a position, by position then id. */
function chartElements(entries: Entries, index: ChartIndex, path: string): Slot[] {
  return [...index.get(path) ?? []]
    .map(id => ({ id, at: entries.get(`@${path}/${id}`) }))
    .filter((slot): slot is Slot => typeof slot.at === 'number')
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function chartValue(entries: Entries, index: ChartIndex, path: string): unknown {
  if (entries.has(`#k${path}`)) {
    const present = new Set([...index.get(path) ?? []].filter(seg =>
      entries.has(`#k${path}/${seg}`) || entries.has(`=${path}/${seg}`) || isChartArray(entries, index, `${path}/${seg}`)));
    const listed = ((entries.get(`#k${path}`) as string[] | undefined) ?? []).filter(seg => present.has(seg));
    const order = [...new Set(listed), ...[...present].filter(seg => !listed.includes(seg)).sort()];
    const object: Record<string, unknown> = {};
    for (const seg of order) object[unsegment(seg)] = chartValue(entries, index, `${path}/${seg}`);
    return object;
  }
  if (isChartArray(entries, index, path)) {
    const slots = chartElements(entries, index, path);
    return remember(slots.map(({ id }) => chartValue(entries, index, `${path}/${id}`)), path, slots);
  }
  return clone(entries.get(`=${path}`));
}
/**
 * The slots of the arrays a decode built, by path, so a write derived from them keeps each element's identity instead
 * of inferring it; a `RegisterDraft` records the same for the arrays its text parses to (null: a new element).
 */
const knownSlots = new WeakMap<readonly unknown[], Map<string, readonly (Slot | null)[]>>();
function remember<T extends readonly unknown[]>(array: T, path: string, slots: readonly (Slot | null)[]): T {
  const byPath = knownSlots.get(array) ?? new Map<string, readonly (Slot | null)[]>();
  knownSlots.set(array, byPath.set(path, slots));
  return array;
}

/**
 * Ids and positions for `value`'s elements. Known slots win; otherwise an element continuing one of `ref`'s array
 * keeps its id and position. Without `ref` (a register's first encoding) ids are repeatable; a live write that creates
 * an array, or adds elements, mints unique ones so a peer doing the same at once never shares them.
 */
function elementSlots(value: readonly unknown[], path: string, ref: Entries | undefined, refIndex: () => ChartIndex): Slot[] {
  const known = knownSlots.get(value)?.get(path);
  let slots: (Slot | null)[];
  if (known?.length === value.length) slots = [...known];
  else if (!ref) return value.map((_, index) => ({ id: `i${index}`, at: index }));
  else if (!isChartArray(ref, refIndex(), path)) slots = value.map(() => null);
  else {
    const prev = chartElements(ref, refIndex(), path);
    slots = alignElements(prev.map(({ id }) => chartValue(ref, refIndex(), `${path}/${id}`)), value).map(j => (j >= 0 ? prev[j] : null));
  }
  // A run of new elements spreads between its neighbours' positions, each at a random point of its own share, so
  // concurrent runs at one spot interleave without tying and a later insert between two of them has room.
  for (let start = 0; start < slots.length; start++) {
    if (slots[start]) continue;
    let end = start;
    while (end < slots.length && !slots[end]) end++;
    const low = start > 0 ? slots[start - 1]!.at : undefined;
    const high = end < slots.length ? slots[end]!.at : undefined;
    const count = end - start + 1;
    for (let k = 1; k < count; k++) {
      const share = k - 0.5 + Math.random();
      const at = low !== undefined && high !== undefined ? low + ((high - low) * share) / count
        : low !== undefined ? low + share : high !== undefined ? high - count + share : share - 1;
      slots[start + k - 1] = { id: `n${crypto.randomUUID().slice(0, 13)}`, at };
    }
    start = end;
  }
  return slots as Slot[];
}

/** Where a JSON text puts each value: arrays list their items' spans, objects their fields'. */
interface Span { start: number; end: number; items?: Span[]; fields?: Map<string, Span> }
const JSON_STRING = /"(?:[^"\\]|\\.)*"/y;
const JSON_SCALAR = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
function jsonSpans(text: string): Span | undefined {
  let at = 0;
  const space = () => { while (at < text.length && /\s/.test(text[at])) at++; };
  const token = (pattern: RegExp) => {
    pattern.lastIndex = at;
    const found = pattern.exec(text);
    if (!found) throw new SyntaxError('not JSON');
    at += found[0].length;
    return found[0];
  };
  const value = (): Span => {
    space();
    const start = at;
    const open = text[at];
    if (open !== '{' && open !== '[') {
      token(open === '"' ? JSON_STRING : JSON_SCALAR);
      return { start, end: at };
    }
    at++;
    const close = open === '{' ? '}' : ']';
    const items: Span[] = [];
    const fields = new Map<string, Span>();
    space();
    if (text[at] === close) at++;
    else {
      for (;;) {
        if (open === '{') {
          space();
          const key = JSON.parse(token(JSON_STRING)) as string;
          space();
          if (text[at++] !== ':') throw new SyntaxError('not JSON');
          fields.set(key, value());
        } else items.push(value());
        space();
        const next = text[at++];
        if (next === close) break;
        if (next !== ',') throw new SyntaxError('not JSON');
      }
    }
    return open === '{' ? { start, end: at, fields } : { start, end: at, items };
  };
  try {
    const root = value();
    space();
    return at === text.length ? root : undefined;
  } catch { return undefined; }
}

/**
 * A text draft of a register value (the chart's JSON editor). It follows each edit to know which characters of the
 * opening text survive, so a save keeps the identity of every array element whose opening and closing characters
 * both survive inside one element, however much the person changed inside it. An element whose text was deleted or
 * retyped is new; only an equal element (an undone deletion) can take an unmatched one's place.
 */
export class RegisterDraft {
  private readonly base: unknown;
  private readonly baseText: string;
  private text: string;
  private origin: Int32Array;
  constructor(base: unknown, baseText: string) {
    this.base = base;
    this.baseText = baseText;
    this.text = baseText;
    this.origin = Int32Array.from({ length: baseText.length }, (_, index) => index);
  }

  /** `next` is the draft after one edit; `caret` (the selection end after it) places the edit exactly. */
  edit(next: string, caret?: number): void {
    const prev = this.text;
    let tail = 0;
    const after = caret === undefined || caret < 0 ? undefined : next.slice(caret);
    if (after !== undefined && after.length <= prev.length && prev.endsWith(after)) tail = after.length;
    else while (tail < prev.length && tail < next.length && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    let head = 0;
    while (head < prev.length - tail && head < next.length - tail && prev[head] === next[head]) head++;
    const origin = new Int32Array(next.length).fill(-1);
    origin.set(this.origin.subarray(0, head));
    origin.set(this.origin.subarray(prev.length - tail), next.length - tail);
    this.origin = origin;
    this.text = next;
  }

  /** Records element identity on `value`: the draft's current text, as its caller parsed and validated it. */
  identify(value: unknown): void {
    const now = jsonSpans(this.text);
    const then = jsonSpans(this.baseText);
    if (now && then) this.walk(value, now, this.base, then, '');
  }

  private walk(value: unknown, now: Span, base: unknown, then: Span, path: string): void {
    if (Array.isArray(value) && Array.isArray(base) && now.items && then.items) {
      const known = knownSlots.get(base)?.get(path);
      if (!known || known.length !== base.length || then.items.length !== base.length || now.items.length !== value.length) return;
      // A caller may put another key's array here (moss copies the first series into `data`); hint only the text's.
      if (!sameValue(value, JSON.parse(this.text.slice(now.start, now.end)))) return;
      const opens = new Map(then.items.map((span, index) => [span.start, index] as const));
      const closes = new Map(then.items.map((span, index) => [span.end - 1, index] as const));
      let last = -1;
      const match = now.items.map((span) => {
        const opened = new Set<number>();
        for (let at = span.start; at < span.end; at++) {
          const from = this.origin[at];
          if (from < 0) continue;
          const open = opens.get(from);
          if (open !== undefined) opened.add(open);
          const close = closes.get(from);
          if (close !== undefined && close > last && opened.has(close)) return (last = close);
        }
        return -1;
      });
      matchEqualInGaps(base, value, match);
      remember(value, path, match.map(j => (j >= 0 ? known[j] : null)));
      match.forEach((j, k) => {
        const slot = j >= 0 ? known[j] : null;
        if (slot) this.walk(value[k], now.items![k], base[j], then.items![j], `${path}/${slot.id}`);
      });
    } else if (isPlainObject(value) && isPlainObject(base) && now.fields && then.fields) {
      for (const key of Object.keys(value)) {
        const field = now.fields.get(key);
        const was = then.fields.get(key);
        if (field && was && key in base) this.walk(value[key], field, base[key], was, `${path}/${segment(key)}`);
      }
    }
  }
}

interface Label { id?: unknown; [key: string]: unknown }
const SKETCH_CELLS = 120 * 60;
/** The sketch grid as one key per inked cell (`c<index>`), labels by id (`l<id>`) with `#l` holding their order. */
const sketchCodec: MapCodec = {
  fields: ['__grid', '__labels'],
  encode(fields) {
    const out = new Map<string, unknown>();
    if (Array.isArray(fields.__grid)) {
      out.set('#n', fields.__grid.length);
      fields.__grid.forEach((on, index) => { if (on) out.set(`c${index}`, true); });
    }
    if (Array.isArray(fields.__labels)) {
      const ids: string[] = [];
      for (const label of fields.__labels as Label[]) {
        let id = String(label.id ?? '');
        while (ids.includes(id)) id += '+';
        ids.push(id);
        out.set(`l${id}`, clone(label));
      }
      out.set('#l', ids);
    }
    return out;
  },
  decode(entries) {
    const size = typeof entries.get('#n') === 'number' ? entries.get('#n') as number : SKETCH_CELLS;
    const grid = new Array<boolean>(size).fill(false);
    const present: string[] = [];
    for (const [key, value] of entries.entries()) {
      if (key.startsWith('c') && value === true) {
        const index = Number(key.slice(1));
        if (Number.isInteger(index) && index >= 0 && index < size) grid[index] = true;
      } else if (key.startsWith('l')) present.push(key.slice(1));
    }
    const listed = ((entries.get('#l') as string[] | undefined) ?? []).filter(id => present.includes(id));
    const order = [...new Set(listed), ...present.filter(id => !listed.includes(id)).sort()];
    return { __grid: grid, __labels: order.map(id => clone(entries.get(`l${id}`))) };
  },
};

/** Compound payloads (T3.3): per-key `Y.Map` registers. */
export const MAP_REGISTERS: Readonly<Record<string, MapCodec>> = { chart: chartCodec, sketch: sketchCodec };

type RegisterNode = LexicalNode & { __regId: string; [key: string]: unknown };
const bindings = new WeakMap<LexicalEditor, Y.Doc>();
const nodeDocs = new WeakMap<LexicalNode, Y.Doc>();
const serialized = new WeakSet<Y.Doc>();
let bindingCount = 0;

export const registerDoc = (editor: LexicalEditor): Y.Doc | undefined => bindings.get(editor);

const fieldsOf = (node: RegisterNode | Record<string, unknown>, codec: MapCodec): Fields =>
  Object.fromEntries(codec.fields.map(field => [field, node[field]]));

/** Upgrade pre-register V1 nodes in place, before admission; retain legacy attributes. */
export function migrateRegisters(doc: Y.Doc): void {
  const registers = doc.getMap<unknown>('registers');
  const visit = (type: Y.XmlText | Y.XmlElement) => {
    const attrs = type.getAttributes() as Record<string, unknown>;
    const field = REGISTER_FIELDS[String(attrs.__type)];
    const codec = MAP_REGISTERS[String(attrs.__type)];
    const legacy = (field && typeof attrs[field] === 'string') || (codec && codec.fields.some(name => attrs[name] !== undefined));
    if (legacy && !attrs.__regId) {
      const item = type._item;
      if (!item) return;
      const id = `legacy:${item.id.client}:${item.id.clock}`;
      if (!registers.has(id)) registers.set(id, field ? new Y.Text(attrs[field] as string) : new Y.Map(codec.encode(fieldsOf(attrs, codec))));
      type.setAttribute('__regId', id);
    }
    const children = type instanceof Y.XmlText ? type.toDelta().map((op: { insert?: unknown }) => op.insert) : type.toArray();
    for (const child of children) if (child instanceof Y.XmlText || child instanceof Y.XmlElement) visit(child);
  };
  doc.transact(() => visit(doc.get('root', Y.XmlText)), REGISTER_INIT);
}
function currentDoc(): Y.Doc | undefined {
  if (!bindingCount) return undefined;
  // SerializedEditorState.toJSON() has no active editor; cached fields cover that read.
  try { return bindings.get($getEditor()); } catch { return undefined; }
}
/** Lexical also reads text while committing, outside an active-editor context. */
export function initRegisterNode(node: LexicalNode): string {
  const doc = currentDoc();
  if (doc) nodeDocs.set(node, doc);
  return '';
}
/** `$copyNode` (Lexical's resetOnCopyNodeFrom): a copy is a new block, so it mints its own register. */
export function resetRegisterOnCopy(node: LexicalNode): void {
  (node as RegisterNode).__regId = '';
}
function registerOf(node: LexicalNode): unknown {
  const id = (node as RegisterNode).__regId;
  return id ? (nodeDocs.get(node) ?? currentDoc())?.getMap('registers').get(id) : undefined;
}
export function readRegister(node: LexicalNode, fallback: string): string {
  const text = registerOf(node);
  return text instanceof Y.Text ? text.toString() : fallback ?? '';
}
export function writeRegister(node: LexicalNode, next: string): boolean {
  const doc = currentDoc();
  const id = (node as RegisterNode).__regId;
  const text = id && doc?.getMap('registers').get(id);
  if (doc && text instanceof Y.Text && text.toString() !== next) {
    doc.transact(() => text.applyDelta(diffText(text.toString(), next)), REGISTER_LOCAL_ORIGIN);
  }
  return text instanceof Y.Text;
}

/** The node's compound payload from its register, or undefined when it has none (unbound, or not yet created). */
export function readMapRegister(node: LexicalNode): Fields | undefined {
  const map = registerOf(node);
  const codec = MAP_REGISTERS[node.getType()];
  return codec && map instanceof Y.Map ? codec.decode(map as Y.Map<unknown>) : undefined;
}

/**
 * Writes the keys `next` changes. With `base` (the value the caller derived `next` from), a key the caller left as
 * it was keeps whatever a peer wrote meanwhile; without it the register's current value is the base.
 */
export function writeMapRegister(node: LexicalNode, next: Fields, base?: Fields): boolean {
  const doc = currentDoc();
  const id = (node as RegisterNode).__regId;
  const map = id && doc?.getMap('registers').get(id);
  const codec = MAP_REGISTERS[node.getType()];
  if (!doc || !codec || !(map instanceof Y.Map)) return false;
  // A viewer's write would leave the client and get its socket closed as revoked; its controls are inert instead.
  if (!$getEditor().isEditable()) return true;
  const register = map as Y.Map<unknown>;
  const current = codec.decode(register);
  const before = codec.encode(base ?? Object.fromEntries(Object.keys(next).map(field => [field, current[field]])), register);
  const after = codec.encode(next, before);
  const implied = codec.implied?.(register);
  doc.transact(() => {
    for (const [key, value] of after) {
      if (before.has(key) && sameValue(before.get(key), value) && !implied?.has(key)) continue;
      if (!map.has(key) || !sameValue(map.get(key), value)) map.set(key, value);
    }
    for (const key of before.keys()) if (!after.has(key) && map.has(key)) map.delete(key);
  }, REGISTER_LOCAL_ORIGIN);
  return true;
}

/**
 * Moves `value` by the change from `from` to `to`, key by key: how a view's local copies (its draft, its undo
 * snapshots) take a peer's edit without dropping their own. Returns the fields `value` has.
 */
export function rebaseMapFields(type: string, value: Fields, from: Fields, to: Fields): Fields {
  const codec = MAP_REGISTERS[type];
  const before = codec.encode(from);
  const entries = codec.encode(value, before);
  const after = codec.encode(to, before);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (sameValue(before.get(key), after.get(key))) continue;
    if (after.has(key)) entries.set(key, after.get(key));
    else entries.delete(key);
  }
  const decoded = codec.decode(entries);
  return Object.fromEntries(Object.keys(value).map(field => [field, decoded[field]]));
}

const seedOf = (node: RegisterNode): string => {
  const field = REGISTER_FIELDS[node.getType()];
  return field ? String(node[field]) : JSON.stringify(fieldsOf(node, MAP_REGISTERS[node.getType()]));
};

/**
 * Serialized writers (the DocDO mirror, unbound converters) import repeatable identities; identical blocks still get
 * independent registers. A live editor's import (whole-note paste) can race a peer's, so it mints unique ids.
 */
export function $assignRegisterIds(): void {
  const doc = currentDoc();
  const unique = doc !== undefined && !serialized.has(doc);
  const used = new Set(doc?.getMap('registers').keys());
  const walk = (node: LexicalNode) => {
    const registered = REGISTER_FIELDS[node.getType()] || MAP_REGISTERS[node.getType()];
    if (registered && unique) {
      (node.getWritable() as RegisterNode).__regId = crypto.randomUUID();
    } else if (registered) {
      const target = node as RegisterNode;
      const seed = `${node.getType()}:${seedOf(target)}`;
      let hash = 2166136261;
      for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
      const prefix = `import:${node.getType()}:${(hash >>> 0).toString(16)}`;
      let ordinal = 0;
      while (used.has(`${prefix}:${ordinal}`)) ordinal++;
      const id = `${prefix}:${ordinal}`;
      used.add(id);
      (target.getWritable() as RegisterNode).__regId = id;
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child);
  };
  walk($getRoot());
}

/** Copies a register's value into the node's excluded render cache, writing only what differs. */
function $syncCache(node: RegisterNode, value: unknown): void {
  const field = REGISTER_FIELDS[node.getType()];
  if (field) {
    if (value instanceof Y.Text && node[field] !== value.toString()) node.getWritable()[field] = value.toString();
    return;
  }
  const codec = MAP_REGISTERS[node.getType()];
  if (!codec || !(value instanceof Y.Map)) return;
  const decoded = codec.decode(value as Y.Map<unknown>);
  for (const name of codec.fields) {
    if (!sameValue(node[name], decoded[name])) node.getWritable()[name] = decoded[name];
  }
}

/** Copy shared payloads into Lexical's excluded render cache. Never writes to the shared tree. */
export function $refreshRegisters(editor: LexicalEditor, doc: Y.Doc): void {
  const registers = doc.getMap('registers');
  for (const snapshot of editor.getEditorState()._nodeMap.values()) {
    const type = snapshot.getType();
    if (!REGISTER_FIELDS[type] && !MAP_REGISTERS[type]) continue;
    const node = $getNodeByKey(snapshot.getKey()) as RegisterNode | null;
    if (!node) continue;
    $syncCache(node, registers.get(node.__regId));
  }
}

/** Installed before V1 hydration on both the client and the DocDO mirror (`serializedImports`, one writer). */
export function bindRegisters(editor: LexicalEditor, doc: Y.Doc, { serializedImports = false } = {}): () => void {
  bindings.set(editor, doc);
  if (serializedImports) serialized.add(doc);
  bindingCount++;
  const registers = doc.getMap<unknown>('registers');
  const stops: (() => void)[] = [];
  for (const type of [...Object.keys(REGISTER_FIELDS), ...Object.keys(MAP_REGISTERS)]) {
    const klass = editor._nodes.get(type)?.klass;
    if (!klass) continue;
    stops.push(editor.registerNodeTransform(klass, (value) => {
      const node = value as RegisterNode;
      if (!node.__regId) node.getWritable().__regId = crypto.randomUUID();
      const id = (node.getLatest() as RegisterNode).__regId;
      if (!registers.has(id)) {
        const field = REGISTER_FIELDS[type];
        const created = field ? new Y.Text(String(node[field] ?? '')) : new Y.Map(MAP_REGISTERS[type].encode(fieldsOf(node, MAP_REGISTERS[type])));
        doc.transact(() => registers.set(id, created), REGISTER_INIT);
      }
      $syncCache(node, registers.get(id));
    }));
  }
  let stopped = false;
  let queued = false;
  const refresh = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // The commit listener retries after pending edits; tagging them would drop their Yjs writes.
      if (stopped || editor._pendingEditorState !== null) return;
      // Finish this cache-only update before any later authored update can join it.
      editor.update(() => $refreshRegisters(editor, doc), { tag: COLLABORATION_TAG, skipTransforms: true, discrete: true });
    });
  };
  const observe = (_events: unknown, transaction: Y.Transaction) => {
    if (transaction.origin !== REGISTER_INIT) refresh();
  };
  registers.observeDeep(observe);
  // Hydration can skip transforms, and may deliver the tree after the registers.
  stops.push(editor.registerUpdateListener(refresh));
  return () => { stopped = true; stops.forEach(stop => stop()); registers.unobserveDeep(observe); bindings.delete(editor); bindingCount--; };
}
