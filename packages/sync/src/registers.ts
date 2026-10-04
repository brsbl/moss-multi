import {
  $getEditor, $getNodeByKey, $getRoot, $isElementNode, COLLABORATION_TAG, type EditorState, type LexicalEditor, type LexicalNode, type NodeKey,
} from 'lexical';
import * as Y from 'yjs';
import { diffText, SERVER_CELL_BUDGET } from '@moss-multi/core/text-diff';

export const REGISTER_LOCAL_ORIGIN = Symbol('moss-multi:register-local');
const REGISTER_INIT = Symbol('moss-multi:register-init');
const REFRESH_TAG = 'moss-multi:register-refresh';
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
    const index = chartIndex(entries);
    return { __config: chartKind(entries, index, '') ? chartValue(entries, index, '') : undefined };
  },
  implied(entries) {
    const index = chartIndex(entries);
    const out = new Set<string>();
    for (const path of index.keys()) {
      const kind = chartKind(entries, index, path);
      if (kind === 'array' && !entries.has(`#a${path}`)) out.add(`#a${path}`);
      if (kind === 'object' && !entries.has(`#k${path}`)) out.add(`#k${path}`);
    }
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
type Kind = 'object' | 'array' | 'value' | undefined;
/** The shape of the ids `elementSlots` mints; an unpositioned one is a deleted element's leftover, never an object key. */
const ELEMENT_ID = /^(?:i\d+|n[0-9a-f]{8}-[0-9a-f]{4})$/;
const kindMemo = new WeakMap<ChartIndex, Map<string, Kind>>();
/**
 * What `path` holds. A container's marker belongs to the one write that created it, and Yjs keeps only one of two
 * concurrent writes to a key, so undoing that write can take the marker while members other people wrote remain. A
 * container therefore stays while it has a member: an array while it has a positioned element, an object while it has
 * a present key.
 */
function chartKind(entries: Entries, index: ChartIndex, path: string): Kind {
  let memo = kindMemo.get(index);
  if (!memo) kindMemo.set(index, (memo = new Map()));
  if (memo.has(path)) return memo.get(path);
  let kind: Kind;
  if (entries.has(`#k${path}`)) kind = 'object';
  else if (entries.has(`#a${path}`)) kind = 'array';
  else if (entries.has(`=${path}`)) kind = 'value';
  else if ([...index.get(path) ?? []].some(id => typeof entries.get(`@${path}/${id}`) === 'number')) kind = 'array';
  else if (chartKeys(entries, index, path, []).length) kind = 'object';
  memo.set(path, kind);
  return kind;
}
/** An object's present keys: its listed ones, then the rest sorted, never a leftover element id it does not list. */
function chartKeys(entries: Entries, index: ChartIndex, path: string, listed: readonly string[]): string[] {
  const present = [...index.get(path) ?? []].filter(seg =>
    (listed.includes(seg) || !ELEMENT_ID.test(seg)) && chartKind(entries, index, `${path}/${seg}`) !== undefined);
  return [...new Set(listed.filter(seg => present.includes(seg))), ...present.filter(seg => !listed.includes(seg)).sort()];
}
/** An array's elements in order: those with a position, by position then id. */
function chartElements(entries: Entries, index: ChartIndex, path: string): Slot[] {
  return [...index.get(path) ?? []]
    .map(id => ({ id, at: entries.get(`@${path}/${id}`) }))
    .filter((slot): slot is Slot => typeof slot.at === 'number')
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function chartValue(entries: Entries, index: ChartIndex, path: string): unknown {
  const kind = chartKind(entries, index, path);
  if (kind === 'object') {
    const object: Record<string, unknown> = {};
    for (const seg of chartKeys(entries, index, path, (entries.get(`#k${path}`) as string[] | undefined) ?? [])) {
      object[unsegment(seg)] = chartValue(entries, index, `${path}/${seg}`);
    }
    return object;
  }
  if (kind === 'array') {
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
  else if (chartKind(ref, refIndex(), path) !== 'array') slots = value.map(() => null);
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
/** SketchNode's fixed 120 x 60 grid; the register never sets its size. */
const SKETCH_CELLS = 120 * 60;
const cellOf = (key: string): number | undefined => {
  const match = /^c(\d+)(?:\.|$)/.exec(key);
  return match ? Number(match[1]) : undefined;
};
/**
 * The sketch grid as one key per inking of a cell (`c<index>.<tag>`), labels by id (`l<id>`) with `#l` holding their
 * order. Each new ink gets a fresh tag, so two authors inking one cell write two keys; undoing one keeps the other.
 */
const sketchCodec: MapCodec = {
  fields: ['__grid', '__labels'],
  encode(fields, ref) {
    const out = new Map<string, unknown>();
    if (Array.isArray(fields.__grid)) {
      const inked = new Map<number, string[]>();
      for (const [key, value] of ref?.entries() ?? []) {
        const cell = cellOf(key);
        if (cell !== undefined && value === true) inked.set(cell, [...(inked.get(cell) ?? []), key]);
      }
      const tag = Math.random().toString(36).slice(2, 8);
      fields.__grid.forEach((on, index) => {
        if (on) for (const key of inked.get(index) ?? [`c${index}.${tag}`]) out.set(key, true);
      });
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
    const grid = new Array<boolean>(SKETCH_CELLS).fill(false);
    const present: string[] = [];
    for (const [key, value] of entries.entries()) {
      const cell = cellOf(key);
      if (cell !== undefined) {
        if (value === true && cell < SKETCH_CELLS) grid[cell] = true;
      } else if (key.startsWith('l') && isPlainObject(value)) present.push(key.slice(1));
    }
    const ids = entries.get('#l');
    const listed = (Array.isArray(ids) ? ids : []).filter((id): id is string => present.includes(id));
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
const payloads = new WeakMap<Y.Text, string>();
const invalidated = new WeakSet<Y.Doc>();

/**
 * A register's text, cached between transactions: every Lexical commit reads each top-level node's text, so an
 * uncached read stringifies every register per keystroke. A transaction's changes evict before its observers run,
 * and reads while one is open or still cleaning up bypass the cache.
 */
function payload(text: Y.Text): string {
  const doc = text.doc;
  if (!doc || doc._transaction || doc._transactionCleanups.length) return text.toString();
  if (!invalidated.has(doc)) {
    invalidated.add(doc);
    doc.on('beforeObserverCalls', (transaction: Y.Transaction) => {
      for (const type of transaction.changed.keys()) if (type instanceof Y.Text) payloads.delete(type);
    });
  }
  let value = payloads.get(text);
  if (value === undefined) payloads.set(text, value = text.toString());
  return value;
}

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
  return text instanceof Y.Text ? payload(text) : fallback ?? '';
}
export function writeRegister(node: LexicalNode, next: string): boolean {
  const doc = currentDoc();
  const id = (node as RegisterNode).__regId;
  const text = id && doc?.getMap('registers').get(id);
  const current = doc && text instanceof Y.Text ? payload(text) : next;
  // The DocDO mirror writes text no client typed, so it diffs within the server budget.
  const budget = serialized.has(doc!) ? SERVER_CELL_BUDGET : undefined;
  if (current !== next) doc!.transact(() => (text as Y.Text).applyDelta(diffText(current, next, budget)), REGISTER_LOCAL_ORIGIN);
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

/** The register's raw entries, copied, or undefined when the node has none. */
export function readMapEntries(node: LexicalNode): Map<string, unknown> | undefined {
  const map = registerOf(node);
  return map instanceof Y.Map ? new Map((map as Y.Map<unknown>).entries()) : undefined;
}

/** Applies the change from entries `from` to entries `to` onto `target`, key by key. */
export function moveEntries(target: Map<string, unknown>, from: Entries, to: Entries): Map<string, unknown> {
  for (const key of new Set([...from.keys(), ...to.keys()])) {
    if (from.has(key) === to.has(key) && sameValue(from.get(key), to.get(key))) continue;
    if (to.has(key)) target.set(key, to.get(key));
    else target.delete(key);
  }
  return target;
}

/**
 * Moves `value` by the register's change from entries `from` to entries `to`, key by key: how a view's local copies
 * (its draft, its undo snapshots) take a peer's edit without dropping their own. Keys, not decoded values, carry the
 * change, so a peer's ink on a cell `value` already has still reaches it. Returns the fields `value` has.
 */
export function rebaseMapEntries(type: string, value: Fields, from: Entries, to: Entries): Fields {
  const codec = MAP_REGISTERS[type];
  const decoded = codec.decode(moveEntries(codec.encode(value, from), from, to));
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
  // Ordinals only grow per prefix, so N identical blocks cost O(N), not O(N^2).
  const next = new Map<string, number>();
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
      let ordinal = next.get(prefix) ?? 0;
      while (used.has(`${prefix}:${ordinal}`)) ordinal++;
      next.set(prefix, ordinal + 1);
      const id = `${prefix}:${ordinal}`;
      used.add(id);
      (target.getWritable() as RegisterNode).__regId = id;
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child);
  };
  walk($getRoot());
}

/** Copies a register's value into one node's excluded render cache, writing only what differs. Never writes to the shared tree. */
function $refreshNode(node: LexicalNode | null, registers: Y.Map<unknown>): void {
  if (!node) return;
  const target = node as RegisterNode;
  const value = registers.get(target.__regId);
  const field = REGISTER_FIELDS[node.getType()];
  if (field) {
    if (value instanceof Y.Text && target[field] !== payload(value)) target.getWritable()[field] = payload(value);
    return;
  }
  const codec = MAP_REGISTERS[node.getType()];
  if (!codec || !(value instanceof Y.Map)) return;
  const decoded = codec.decode(value as Y.Map<unknown>);
  for (const name of codec.fields) {
    if (!sameValue(target[name], decoded[name])) target.getWritable()[name] = decoded[name];
  }
}

const isRegisterType = (type: string): boolean => !!REGISTER_FIELDS[type] || !!MAP_REGISTERS[type];

/** Fill every register node's cache once; a hydrated mirror needs it before its first read. */
export function $refreshRegisters(editor: LexicalEditor, doc: Y.Doc): void {
  const registers = doc.getMap<unknown>('registers');
  for (const snapshot of editor.getEditorState()._nodeMap.values()) {
    if (isRegisterType(snapshot.getType())) $refreshNode($getNodeByKey(snapshot.getKey()), registers);
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
      $refreshNode(node.getLatest(), registers);
    }));
  }
  // Refreshes stay proportional to what changed: the nodes an update touched and the registers whose text moved.
  const keysById = new Map<string, Set<NodeKey>>();
  const idByKey = new Map<NodeKey, string>();
  const dirtyKeys = new Set<NodeKey>();
  const dirtyIds = new Set<string>();
  const index = (key: NodeKey, state: EditorState) => {
    const node = state._nodeMap.get(key) as RegisterNode | undefined;
    const id = node && isRegisterType(node.getType()) ? node.__regId : undefined;
    const previous = idByKey.get(key);
    if (previous !== id) {
      if (previous !== undefined) {
        keysById.get(previous)?.delete(key);
        if (!keysById.get(previous)?.size) keysById.delete(previous);
      }
      if (id === undefined) idByKey.delete(key);
      else {
        idByKey.set(key, id);
        let keys = keysById.get(id);
        if (!keys) keysById.set(id, keys = new Set());
        keys.add(key);
      }
    }
    if (id !== undefined) dirtyKeys.add(key);
  };
  let stopped = false;
  let queued = false;
  const refresh = () => {
    if (queued || stopped || (!dirtyKeys.size && !dirtyIds.size)) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // The commit listener retries after pending edits; tagging them would drop their Yjs writes.
      if (stopped || editor._pendingEditorState !== null) return;
      // Finish this cache-only update before any later authored update can join it.
      editor.update(() => {
        const keys = new Set(dirtyKeys);
        for (const id of dirtyIds) for (const key of keysById.get(id) ?? []) keys.add(key);
        dirtyKeys.clear();
        dirtyIds.clear();
        for (const key of keys) $refreshNode($getNodeByKey(key), registers);
      }, { tag: [COLLABORATION_TAG, REFRESH_TAG], skipTransforms: true, discrete: true });
    });
  };
  const observe = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (transaction.origin === REGISTER_INIT) return;
    for (const event of events) {
      if (event.target === registers) for (const id of (event as Y.YMapEvent<unknown>).keysChanged) dirtyIds.add(id);
      else if (typeof event.target._item?.parentSub === 'string') dirtyIds.add(event.target._item.parentSub);
    }
    refresh();
  };
  registers.observeDeep(observe);
  // Hydration can skip transforms, and may deliver the tree after the registers.
  stops.push(editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
    if (!tags.has(REFRESH_TAG)) {
      // setEditorState marks only the root: re-index the whole state once.
      const replaced = dirtyLeaves.size === 0 && dirtyElements.size === 1 && dirtyElements.has('root') && editorState !== prevEditorState;
      const keys = replaced ? new Set([...idByKey.keys(), ...editorState._nodeMap.keys()]) : [...dirtyLeaves, ...dirtyElements.keys()];
      for (const key of keys) index(key, editorState);
    }
    refresh();
  }));
  for (const key of editor.getEditorState()._nodeMap.keys()) index(key, editor.getEditorState());
  refresh();
  return () => { stopped = true; stops.forEach(stop => stop()); registers.unobserveDeep(observe); bindings.delete(editor); bindingCount--; };
}
