// The rows a suggestion card shows for a preview (docs/design/suggestions.md §4.4), generated from the hashed hunks
// themselves: every difference between a hunk's before and after, by channel, yields a row, and nothing is filtered by
// name or by count. Text aligns by Yjs item identity, so a row is exactly the run of items the record removes or adds.
// Each row's `detail` holds where it sits and what it covers, as hashed, so the rows are a lossless reading of the hunks.
//
// Every name here (a field, a node type, a map key) is the record's, so lookups by name use Maps, never an object
// literal. The rows are linear in the hunks: each node is read once and covered by its own row, a nested node's
// text and fields are never repeated in its parent's row, and context repeated on many rows is clipped.
import { digest } from 'lib0/hash/sha256';
import { encodeUtf8 } from 'lib0/string';
import { canonical, hex, previewHash, type Hunk } from './apply.ts';

export interface ReviewRow {
  kind: 'insert' | 'delete' | 'change';
  /** The text the row is about, in full. */
  text: string;
  /** What changed about it, or what it carries (formatting, a link, a node's fields), when that is not plain text. */
  note?: string;
  /** The hunk it belongs to, the path inside it, and the exact hashed values it covers. */
  detail: string;
}

type Json = Record<string, unknown>;

/** A type as the projection renders it (apply.ts `channelValue`). */
interface Node {
  type: string;
  name?: string;
  seq?: unknown[];
  keys?: [string, unknown][];
}

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const isNode = (value: unknown): value is Node => isObject(value) && typeof value.type === 'string' && (Array.isArray(value.seq) || Array.isArray(value.keys));

const FORMATS: [number, string][] = [
  [1, 'bold'], [2, 'italic'], [4, 'strikethrough'], [8, 'underline'], [16, 'code'], [32, 'subscript'], [64, 'superscript'], [128, 'highlight'],
];

function formatNames(format: number): string {
  const names = FORMATS.filter(([bit]) => (format & bit) !== 0).map(([, name]) => name);
  const rest = format & ~FORMATS.reduce((all, [bit]) => all | bit, 0);
  if (rest) names.push(`format ${rest}`);
  return names.length ? names.join(', ') : 'plain';
}

/** A stored value as a reader reads it: a Yjs `Any` wrapper unwrapped. */
const unwrap = (value: unknown): unknown => (isObject(value) && Array.isArray(value.Any) && value.Any.length === 1 ? value.Any[0] : value);

/** A stored key as a reader names it: `__indent` is `indent`, `__dir` is `direction`; any other key is quoted. */
const fieldName = (key: string) => (key === '__dir' ? 'direction' : key.startsWith('__') ? key.slice(2) : JSON.stringify(key));

const fieldsOf = (node: Node): [string, unknown][] =>
  Array.isArray(node.keys) ? node.keys.filter((pair): pair is [string, unknown] => Array.isArray(pair) && typeof pair[0] === 'string') : [];

const ALIGNMENTS = ['none', 'left', 'center', 'right', 'justify', 'start', 'end'];

/** A value as a reader reads it; `key` and its `holder` name a format (a text node's bits, an element's alignment). */
function show(value: unknown, key = '', holder?: Node): string {
  const v = unwrap(value);
  if (v === undefined) return 'none';
  const textFormat = key === '__textFormat' || (key === '__format' && !!holder && holder.type === 'Map');
  const alignment = key === '__format' && !textFormat;
  // A string that would read as another value (a number, a format name, nothing) is quoted.
  if (typeof v === 'string') return textFormat || alignment || /^(|none|null|true|false|plain)$|^[\s"{[\d.+-]/.test(v) || v.trim() !== v ? JSON.stringify(v) : v;
  if (textFormat && typeof v === 'number') return formatNames(v);
  if (alignment && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < ALIGNMENTS.length) return ALIGNMENTS[v];
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (isNode(v)) return `{${fieldsOf(v).map(([k, item]) => `${fieldName(k)}: ${show(item, k, v)}`).join(', ')}}`;
  return canonical(v);
}

/** Lexical's defaults: a new node holding one says nothing a reader needs, so its note leaves it out. */
const DEFAULTS: ReadonlyMap<string, readonly unknown[]> = new Map<string, readonly unknown[]>([
  ['__format', [0]], ['__style', ['']], ['__mode', ['normal', 0]], ['__detail', [0]], ['__indent', [0]], ['__dir', [null]], ['__textFormat', [0]], ['__textStyle', ['']],
]);
const isEmpty = (value: unknown) => {
  const v = unwrap(value);
  return v === undefined || v === null || v === '';
};
const isDefault = (key: string, value: unknown) => DEFAULTS.get(key)?.includes(unwrap(value)) ?? false;

const INLINE: ReadonlySet<string> = new Set(['link', 'autolink']);

/** Context a row repeats from another node (an enclosing link, the text node a run sits in) is clipped to this. */
const CONTEXT = 80;
const clip = (text: string) => (text.length > CONTEXT ? `${text.slice(0, CONTEXT - 1)}…` : text);

const fingerprint = (text: string) => hex(digest(encodeUtf8(text))).slice(0, 12);

/**
 * A key as a path names it. A long one is clipped and ends in a fingerprint of the whole; at `CONTEXT + 1`
 * characters it is longer than any key shown whole, so two keys never read the same.
 */
const keyLabel = (key: string) => (key.length > CONTEXT ? `${key.slice(0, CONTEXT - 13)}…#${fingerprint(key)}` : key);

/** A path kept to its last characters, led by a fingerprint of the whole (which holds the earlier fingerprints). */
const bounded = (path: string) => (path.length > 2 * CONTEXT ? `#${fingerprint(path)}…${path.slice(-(2 * CONTEXT - 13))}` : path);

/**
 * A row's path one key deeper. Every row below a key repeats its path, so it is bounded: a row costs a constant
 * beyond what it covers, and two paths never read the same.
 */
const sub = (path: string, key: string) => bounded(`${path} ${keyLabel(key)}`);

/** The fields a nested row sits in, as a reader names them, bounded as a path is. */
const within = (fields: string, key: string) => bounded(fields ? `${fields} › ${keyLabel(fieldName(key))}` : keyLabel(fieldName(key)));

/** Work counters: `calls` per describeHunks, `units` per sequence piece built. */
export const describeStats = { calls: 0, units: 0 };

type Owner = { id: string; node: Node };

/**
 * A run of a sequence: characters whose ids are consecutive clocks of one client (`s`), or one other item (`node`).
 * A character run carries its text node (the last map before it, Lexical's V1 binding) and its offset in the text.
 */
interface Piece {
  /** The item id's client; an id that is not `client:clock` is a client of its own. */
  client: string;
  clock: number;
  len: number;
  id: string;
  s?: string;
  node?: unknown;
  owner: Owner | null;
  at: number;
}

type CharPiece = Piece & { s: string };
const isChar = (p: Piece): p is CharPiece => typeof p.s === 'string';

const OPAQUE = '\u0000';

function piece(fields: Omit<Piece, 'client' | 'clock'> & { client?: string; clock?: number }): Piece {
  describeStats.units += 1;
  let { client, clock } = fields;
  if (client === undefined || clock === undefined) {
    const match = /^(\d+):(\d+)$/.exec(fields.id);
    const parsed = match ? Number(match[2]) : NaN;
    if (match && Number.isSafeInteger(parsed)) [client, clock] = [String(Number(match[1])), parsed];
    else [client, clock] = [OPAQUE + fields.id, 0];
  }
  return { ...fields, client, clock };
}

const idText = (client: string, clock: number) => (client.startsWith(OPAQUE) ? (clock ? `${client.slice(1)}#${clock}` : client.slice(1)) : `${client}:${clock}`);

/** Characters `from` to `to` of a character piece. */
function slice(p: Piece, from: number, to: number): Piece {
  if (from === 0 && to === p.len) return p;
  const clock = p.clock + from;
  return piece({ ...p, clock, id: idText(p.client, clock), len: to - from, s: p.s!.slice(from, to), at: p.at + from });
}

/** A sequence as pieces, each character run with its text node. */
function pieces(seq: unknown[] | undefined): Piece[] {
  const out: Piece[] = [];
  let owner: Owner | null = null;
  let at = 0;
  for (const entry of seq ?? []) {
    if (!isObject(entry)) {
      out.push(piece({ id: '?', len: 1, node: entry, owner: null, at }));
      owner = null;
      continue;
    }
    const id = typeof entry.id === 'string' ? entry.id : '?';
    if (typeof entry.s === 'string') {
      if (entry.s.length) out.push(piece({ id, len: entry.s.length, s: entry.s, owner, at }));
      at += entry.s.length;
    } else {
      const node = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'id'));
      out.push(piece({ id, len: 1, node, owner: null, at }));
      owner = isNode(node) && node.type === 'Map' ? { id, node } : null;
    }
  }
  return out;
}

/** Ids as runs: `client:clock+length`. */
function idRuns(list: readonly Piece[]): string {
  const runs: string[] = [];
  let start = '';
  let client = '';
  let next = NaN;
  let len = 0;
  const flush = () => {
    if (len) runs.push(len === 1 ? start : `${start}+${len}`);
  };
  for (const p of list) {
    if (p.client === client && p.clock === next && !client.startsWith(OPAQUE)) {
      len += p.len;
      next += p.len;
      continue;
    }
    flush();
    start = p.id;
    client = p.client;
    next = p.clock + p.len;
    len = p.len;
  }
  flush();
  return runs.join(',');
}

/** Each client's id intervals, sorted and merged: `[start, end, start, end, …]`. */
function intervals(list: readonly Piece[]): Map<string, number[]> {
  const by = new Map<string, [number, number][]>();
  for (const p of list) {
    const spans = by.get(p.client);
    if (spans) spans.push([p.clock, p.clock + p.len]);
    else by.set(p.client, [[p.clock, p.clock + p.len]]);
  }
  const out = new Map<string, number[]>();
  for (const [client, spans] of by) {
    spans.sort((x, y) => x[0] - y[0]);
    const flat: number[] = [];
    for (const [s, e] of spans) {
      if (flat.length && s <= flat[flat.length - 1]) flat[flat.length - 1] = Math.max(flat[flat.length - 1], e);
      else flat.push(s, e);
    }
    out.set(client, flat);
  }
  return out;
}

/** `list` cut where its ids enter or leave `other`'s, each part marked present in `other` or not. */
function presence(list: readonly Piece[], other: Map<string, number[]>): { p: Piece; present: boolean }[] {
  const out: { p: Piece; present: boolean }[] = [];
  for (const p of list) {
    const flat = other.get(p.client);
    if (!flat) {
      out.push({ p, present: false });
      continue;
    }
    const end = p.clock + p.len;
    const count = flat.length / 2;
    // The first interval ending after the piece starts.
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (flat[2 * mid + 1] <= p.clock) lo = mid + 1;
      else hi = mid;
    }
    let pos = p.clock;
    for (let k = lo; pos < end; k++) {
      const s = k < count ? Math.min(flat[2 * k], end) : end;
      const e = k < count ? Math.min(flat[2 * k + 1], end) : end;
      if (s > pos) {
        out.push({ p: slice(p, pos - p.clock, s - p.clock), present: false });
        pos = s;
      }
      if (e > pos) {
        out.push({ p: slice(p, pos - p.clock, e - p.clock), present: true });
        pos = e;
      }
    }
  }
  return out;
}

type Step = { op: 'keep'; b: Piece; a: Piece } | { op: 'delete'; b: Piece } | { op: 'insert'; a: Piece };

/**
 * Two sequences aligned by item identity, a run at a time: an item in both is kept, one only before is removed, one
 * only after added.
 */
function align(before: readonly Piece[], after: readonly Piece[]): Step[] {
  const b = presence(before, intervals(after));
  const a = presence(after, intervals(before));
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  // How far into b[i] and a[j] the walk is.
  let bi = 0;
  let aj = 0;
  const del = (to: number) => {
    steps.push({ op: 'delete', b: slice(b[i].p, bi, to) });
    if (to === b[i].p.len) [i, bi] = [i + 1, 0];
    else bi = to;
  };
  const ins = (to: number) => {
    steps.push({ op: 'insert', a: slice(a[j].p, aj, to) });
    if (to === a[j].p.len) [j, aj] = [j + 1, 0];
    else aj = to;
  };
  while (i < b.length || j < a.length) {
    if (i < b.length && (j >= a.length || !b[i].present)) {
      del(b[i].p.len);
      continue;
    }
    if (j < a.length && (i >= b.length || !a[j].present)) {
      ins(a[j].p.len);
      continue;
    }
    const x = b[i].p;
    const y = a[j].p;
    const xStart = x.clock + bi;
    const yStart = y.clock + aj;
    if (x.client !== y.client || xStart !== yStart) {
      // Out of order (Yjs never moves an item): removed here, up to where the next added item starts.
      del(x.client === y.client && yStart > xStart && yStart < x.clock + x.len ? yStart - x.clock : x.len);
      continue;
    }
    if (isChar(x) !== isChar(y)) {
      del(bi + 1);
      ins(aj + 1);
      continue;
    }
    const n = Math.min(x.len - bi, y.len - aj);
    let same = n;
    if (isChar(x) && x.s.slice(bi, bi + n) !== y.s!.slice(aj, aj + n)) {
      same = 0;
      while (x.s.charCodeAt(bi + same) === y.s!.charCodeAt(aj + same)) same += 1;
    }
    if (same) {
      steps.push({ op: 'keep', b: slice(x, bi, bi + same), a: slice(y, aj, aj + same) });
      if (bi + same === x.len) [i, bi] = [i + 1, 0];
      else bi += same;
      if (aj + same === y.len) [j, aj] = [j + 1, 0];
      else aj += same;
      continue;
    }
    // One id holding two different characters (never so in Yjs, but hashed as such) is removed and added.
    let differ = 1;
    while (differ < n && x.s!.charCodeAt(bi + differ) !== y.s!.charCodeAt(aj + differ)) differ += 1;
    del(bi + differ);
    ins(aj + differ);
  }
  return steps;
}

/** Consecutive removed or added pieces of `steps` from `i`, and where the run ends. */
function runAt(steps: readonly Step[], i: number): { op: 'delete' | 'insert'; run: Piece[]; end: number } {
  const op = steps[i].op as 'delete' | 'insert';
  const run: Piece[] = [];
  let end = i;
  for (; end < steps.length && steps[end].op === op; end++) {
    const step = steps[end] as { op: 'delete'; b: Piece } | { op: 'insert'; a: Piece };
    run.push('b' in step ? step.b : step.a);
  }
  return { op, run, end };
}

/** Each text node's characters, by the id of its map. */
function ownedText(list: readonly Piece[]): Map<string, string> {
  const parts = new Map<string, string[]>();
  for (const p of list) {
    if (!isChar(p) || !p.owner) continue;
    const held = parts.get(p.owner.id);
    if (held) held.push(p.s);
    else parts.set(p.owner.id, [p.s]);
  }
  return new Map([...parts].map(([id, held]) => [id, held.join('')]));
}

/**
 * A node as one row covers it: its own fields and sequence, each nested element named by its kind (its own row covers
 * it), and each text node's map kept, its nested nodes named likewise. So no subtree is covered twice.
 */
function shallow(node: Node): Json {
  const out: Json = { type: node.type };
  if (node.name !== undefined) out.name = node.name;
  if (Array.isArray(node.keys)) out.keys = node.keys.map((pair) => (Array.isArray(pair) && isNode(pair[1]) ? [pair[0], { node: pair[1].type }] : pair));
  if (Array.isArray(node.seq)) {
    out.seq = node.seq.map((entry) => {
      if (!isObject(entry) || !isNode(entry)) return entry;
      const id = entry.id ?? null;
      return entry.type === 'Map' && !Array.isArray(entry.seq) ? { id, ...shallow(entry) } : { id, node: entry.type };
    });
  }
  return out;
}

/** What every row of one call reads, computed once per node. */
class Reader {
  readonly #types = new WeakMap<object, string>();
  readonly #carried = new WeakMap<object, string[]>();
  readonly #context = new WeakMap<object, string[]>();
  readonly #keys = new WeakMap<object, string>();

  /** What a node is called: its Lexical type, else its element name, else its Yjs kind. */
  typeName(node: Node): string {
    let type = this.#types.get(node);
    if (type === undefined) {
      const named = unwrap(fieldsOf(node).find(([k]) => k === '__type')?.[1]);
      type = typeof named === 'string' ? named : typeof node.name === 'string' ? node.name : node.type === 'Map' ? 'map' : node.type === 'XmlElement' ? 'decorator' : 'element';
      this.#types.set(node, type);
    }
    return type;
  }

  isInline(node: Node): boolean {
    return INLINE.has(this.typeName(node));
  }

  /**
   * A node's own fields as `name: value`, for a node that is new or removed whole, or a text node a run sits in (its
   * type names it; empty values, Lexical's defaults and nested nodes, which have their own rows, are left out). A
   * changed field is never filtered: see `Rows.node`.
   */
  carried(node: Node): string[] {
    let out = this.#carried.get(node);
    if (out === undefined) {
      out = fieldsOf(node)
        .filter(([key, value]) => key !== '__type' && !isNode(value) && !isDefault(key, value) && !isEmpty(value))
        .map(([key, value]) => (key === '__format' && node.type === 'Map' ? show(value, key, node) : `${fieldName(key)}: ${show(value, key, node)}`));
      this.#carried.set(node, out);
    }
    return out;
  }

  /** A text node's fields as context for a run inside it: one clipped entry. */
  context(node: Node): string[] {
    let out = this.#context.get(node);
    if (out === undefined) {
      const full = this.carried(node).join('; ');
      out = full ? [clip(full)] : [];
      this.#context.set(node, out);
    }
    return out;
  }

  /**
   * A node's own text as a reader sees it: its characters, a line break or tab, a decorator as `[type]`, and an inline
   * child's (a link's) own text. A nested block reads in its own row.
   */
  textOf(value: unknown, inner = false): string {
    if (typeof value === 'string') return value;
    if (!isNode(value)) return '';
    if (!Array.isArray(value.seq)) {
      const type = this.typeName(value);
      return type === 'linebreak' ? '\n' : type === 'tab' ? '\t' : value.type === 'Map' ? '' : `[${clip(type)}]`;
    }
    let text = '';
    for (const entry of value.seq) {
      if (isObject(entry) && typeof entry.s === 'string') text += entry.s;
      else if (!isNode(entry)) continue;
      else if (!Array.isArray(entry.seq)) text += this.textOf(entry, true);
      else if (!inner && this.isInline(entry)) text += this.textOf(entry, true);
    }
    return text;
  }

  labelOf(node: Node): string {
    return this.textOf(node).trim() || this.typeName(node);
  }

  /** A value's fingerprint: equal exactly when the values' canonical JSON is, computed once per object. */
  key(value: unknown): string {
    if (typeof value === 'bigint') return canonical(value);
    if (value === null || typeof value !== 'object') return value === undefined ? 'u' : (JSON.stringify(value) ?? 'u');
    let out = this.#keys.get(value);
    if (out !== undefined) return out;
    if (Array.isArray(value)) out = `[${value.map((item) => (item === undefined ? 'null' : this.key(item))).join(',')}]`;
    else {
      const record = value as Json;
      const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${this.key(record[k])}`).join(',')}}`;
    }
    if (out.length > 64) out = `#${hex(digest(encodeUtf8(out)))}`;
    this.#keys.set(value, out);
    return out;
  }

  same(a: unknown, b: unknown): boolean {
    return this.key(a) === this.key(b);
  }
}

class Rows {
  readonly out: ReviewRow[] = [];

  constructor(
    readonly where: string,
    readonly read: Reader,
  ) {}

  push(kind: ReviewRow['kind'], path: string, text: string, note: string | undefined, covers: unknown): void {
    const detail = `${this.where}${path ? ` ${path}` : ''}: ${canonical(covers ?? null)}`;
    this.out.push(note ? { kind, text, note, detail } : { kind, text, detail });
  }

  /**
   * A value the record adds or removes whole: one row with the value and its own fields, then a row for each node it
   * holds and each run of its text a reader would not see in that row's text (a formatted run). `quiet` leaves out a
   * text node's map with nothing to add, which the enclosing row covers.
   */
  whole(kind: 'insert' | 'delete', path: string, value: unknown, quiet = false): void {
    const verb = kind === 'insert' ? 'new' : 'removes';
    if (!isNode(value)) {
      this.push(kind, path, typeof value === 'string' ? value : show(value), typeof value === 'string' ? undefined : `${verb} content`, value);
      return;
    }
    const own = this.read.carried(value);
    if (!(quiet && value.type === 'Map' && own.length === 0)) {
      const type = this.read.typeName(value);
      this.push(kind, path, this.read.textOf(value) || `[${clip(type)}]`, [`${verb} ${type}`, ...own].join('; '), shallow(value));
    }
    if (Array.isArray(value.seq)) {
      this.sequence(kind, path, pieces(value.seq), [], true);
    }
    this.fields(kind, path, value);
  }

  /** The nodes a node holds as field values, each in its own rows; an empty one (its kind is in the parent's detail) has none. */
  fields(kind: 'insert' | 'delete', path: string, node: Node): void {
    for (const [key, item] of fieldsOf(node)) {
      if (isNode(item) && (fieldsOf(item).length > 0 || (item.seq?.length ?? 0) > 0)) this.whole(kind, sub(path, key), item);
    }
  }

  /**
   * Pieces all added or all removed: runs of characters by text node, and every other item. A text node's map whose
   * characters follow it is said by their row. `quiet` leaves out what has nothing to add to an enclosing row.
   */
  sequence(kind: 'insert' | 'delete', path: string, list: readonly Piece[], chain: readonly string[], quiet: boolean): void {
    for (let i = 0; i < list.length; ) {
      const unit = list[i];
      const map: Owner | null = !isChar(unit) && isNode(unit.node) && unit.node.type === 'Map' ? { id: unit.id, node: unit.node } : null;
      if (!isChar(unit) && !map) {
        this.whole(kind, sub(path, unit.id), unit.node, quiet);
        i += 1;
        continue;
      }
      const owner = map ?? unit.owner;
      // The map, when it is in this run, and the characters of its text node that follow it.
      const run: Piece[] = [];
      if (map) run.push(list[i++]);
      for (; i < list.length; i++) {
        const next = list[i];
        if (!isChar(next) || next.owner?.id !== owner?.id) break;
        run.push(next);
      }
      const text = run.map((p) => p.s ?? '').join('');
      if (map && !text) {
        this.whole(kind, sub(path, map.id), map.node, quiet);
        continue;
      }
      // A text node of another Lexical type says so, then its fields: in full when its map is in this run (said once),
      // clipped when the run only sits in it.
      const lexical = owner ? this.read.typeName(owner.node) : 'text';
      const fields = !owner ? [] : map ? this.read.carried(owner.node) : this.read.context(owner.node);
      const note = [...chain, ...(lexical === 'text' ? [] : [map ? lexical : clip(lexical)]), ...fields];
      if (!quiet || note.length > 0) {
        this.push(kind, path, text, note.join('; ') || undefined, { ids: idRuns(run), node: map ? shallow(map.node) : (owner?.id ?? null) });
      }
      if (map) this.fields(kind, sub(path, map.id), map.node);
    }
  }

  /**
   * Two versions of one node: each field that differs, then its sequence aligned by identity. `fields` names the
   * fields of enclosing nodes it sits in, so a change inside one field never reads as the same change inside another.
   */
  node(path: string, b: Node, a: Node, label: string, fields = ''): void {
    const type = this.read.typeName(a);
    const before = new Map(fieldsOf(b));
    const after = new Map(fieldsOf(a));
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const was = before.get(key);
      const now = after.get(key);
      if (this.read.same(was, now)) continue;
      if (isNode(was) && isNode(now) && was.type === now.type) {
        this.node(sub(path, key), was, now, label, within(fields, key));
        continue;
      }
      const at = fields ? `${fields} › ` : '';
      this.push('change', sub(path, key), label, `${clip(type)} ${at}${fieldName(key)}: ${show(was, key, b)} → ${show(now, key, a)}`, { before: was ?? null, after: now ?? null });
    }
    if (this.read.same(b.seq, a.seq)) return;
    // Runs inside a link say so, with the link's fields clipped; the link's own changes have their own rows.
    const inner = this.read.isInline(a) ? [clip([type, ...this.read.carried(a)].join('; '))] : [];
    const au = pieces(a.seq);
    const texts = ownedText(au);
    const steps = align(pieces(b.seq), au);
    for (let i = 0; i < steps.length; ) {
      const step = steps[i];
      if (step.op === 'keep') {
        if (!isChar(step.b) && !isChar(step.a)) this.value(sub(path, step.a.id), step.b.node, step.a.node, texts.get(step.a.id));
        i += 1;
        continue;
      }
      const { op, run, end } = runAt(steps, i);
      this.sequence(op, path, run, inner, false);
      i = end;
    }
  }

  /** Two versions of a value: a node of one kind is compared field by field, anything else is replaced. */
  value(path: string, b: unknown, a: unknown, label?: string): void {
    if (this.read.same(b, a)) return;
    if (isNode(b) && isNode(a) && b.type === a.type && b.name === a.name) {
      this.node(path, b, a, clip(label?.trim() || this.read.labelOf(a)));
      return;
    }
    if (b !== undefined) this.whole('delete', path, b);
    if (a !== undefined) this.whole('insert', path, a);
  }

  /** Two lists of `[key, value]` pairs (the note's settings, a payload's fields): each key that differs. */
  keys(path: string, text: string, before: unknown, after: unknown): void {
    const b = new Map(pairsOf(before));
    const a = new Map(pairsOf(after));
    for (const key of [...new Set([...b.keys(), ...a.keys()])].sort()) {
      const was = b.get(key);
      const now = a.get(key);
      if (this.read.same(was, now)) continue;
      if (isNode(was) && isNode(now) && was.type === now.type) {
        this.node(sub(path, key), was, now, text, within('', key));
        continue;
      }
      this.push('change', sub(path, key), text, `${fieldName(key)}: ${show(was, key)} → ${show(now, key)}`, { before: was ?? null, after: now ?? null });
    }
    // A value that is not a list of pairs is compared whole.
    const loose = (value: unknown) => (value === undefined || Array.isArray(value) ? null : value);
    if (!this.read.same(loose(before), loose(after))) {
      this.push('change', path, text, `${show(loose(before))} → ${show(loose(after))}`, { before: before ?? null, after: after ?? null });
    }
  }

  /**
   * A payload's two versions: its text aligned by identity, each changed stretch of lines one row reading the lines
   * after and before, then its fields.
   */
  payload(before: unknown, after: unknown): void {
    const was = payloadPieces(before);
    const now = payloadPieces(after);
    const lines = { b: new LineCounter(was.text), a: new LineCounter(now.text) };
    let group: Changed | null = null;
    let bPos = 0;
    let aPos = 0;
    const flush = () => {
      if (group) this.lines(group, lines);
      group = null;
    };
    for (const step of align(was.pieces, now.pieces)) {
      if (step.op === 'keep') {
        if (!isChar(step.b) || !isChar(step.a)) continue;
        // A kept line break ends a stretch.
        if (group && (step.b.s.includes('\n') || step.a.s.includes('\n'))) flush();
        bPos = step.b.at + step.b.len;
        aPos = step.a.at + step.a.len;
        continue;
      }
      const p = step.op === 'delete' ? step.b : step.a;
      if (!isChar(p)) {
        this.push(step.op, `text ${p.id}`, show(p.node), 'block content', p.node);
        continue;
      }
      group ??= { removed: [], added: [], b: [bPos, bPos], a: [aPos, aPos] };
      if (step.op === 'delete') {
        group.removed.push(p);
        bPos = p.at + p.len;
      } else {
        group.added.push(p);
        aPos = p.at + p.len;
      }
      group.b[1] = bPos;
      group.a[1] = aPos;
    }
    flush();
    // Anything else the value holds is compared whole.
    const rest = (value: unknown) =>
      isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'text' && key !== 'ids' && key !== 'map')) : (value ?? {});
    if (!this.read.same(rest(before), rest(after))) {
      this.push('change', '', 'Block content', `${show(rest(before))} → ${show(rest(after))}`, { before: rest(before), after: rest(after) });
    }
    this.keys('map', 'Block content', isObject(before) ? before.map : undefined, isObject(after) ? after.map : undefined);
  }

  /** One changed stretch of a payload's text: the lines after it, and the lines before it in the note. */
  lines(group: Changed, lines: { b: LineCounter; a: LineCounter }): void {
    const kind = group.removed.length && group.added.length ? 'change' : group.added.length ? 'insert' : 'delete';
    // Text removed and added again at the stretch's end (an edit written from the caret) reads as unchanged.
    const lastRemoved = group.removed.at(-1);
    const lastAdded = group.added.at(-1);
    if (lastRemoved && lastAdded && lastRemoved.at + lastRemoved.len === group.b[1] && lastAdded.at + lastAdded.len === group.a[1]) {
      const most = Math.min(trailing(group.removed), trailing(group.added));
      let same = 0;
      while (same < most && lines.b.text.charCodeAt(group.b[1] - 1 - same) === lines.a.text.charCodeAt(group.a[1] - 1 - same)) same += 1;
      if (same > 0 && isLowSurrogate(lines.b.text, group.b[1] - same)) same -= 1;
      group.b[1] -= same;
      group.a[1] -= same;
    }
    // A removal reads the old lines and what they are now; anything else the new lines and what they were.
    const removal = kind === 'delete';
    const shownSide = removal ? lines.b : lines.a;
    const otherSide = removal ? lines.a : lines.b;
    const [from, to] = removal ? group.b : group.a;
    const [otherFrom, otherTo] = removal ? group.a : group.b;
    const text = shownSide.around(from, to);
    const first = shownSide.lineAt(from);
    const last = first + (text.match(/\n/g)?.length ?? 0);
    const where = last > first ? `lines ${first}–${last}` : `line ${first}`;
    const covers: Json = {};
    if (group.removed.length) covers.removes = idRuns(group.removed);
    if (group.added.length) covers.adds = idRuns(group.added);
    this.push(kind, 'text', text, `block content; ${where}; ${removal ? 'now' : 'was'} ${JSON.stringify(otherSide.around(otherFrom, otherTo))}`, covers);
  }
}

/** A changed stretch of payload text: its removed and added pieces, and its range before and after. */
interface Changed {
  removed: Piece[];
  added: Piece[];
  b: [number, number];
  a: [number, number];
}

/** How many characters end `list` contiguously: the run of its last pieces with no gap between them. */
function trailing(list: readonly Piece[]): number {
  let total = 0;
  for (let k = list.length - 1; k >= 0; k--) {
    if (k < list.length - 1 && list[k].at + list[k].len !== list[k + 1].at) break;
    total += list[k].len;
  }
  return total;
}

const WORD = /[\p{L}\p{N}_$]/u;
const isWord = (text: string, at: number) => at > 0 && at < text.length && WORD.test(text[at - 1]) && WORD.test(text[at]);
const isLowSurrogate = (text: string, at: number) => {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff;
};

/** A text's lines: numbers, counted forward once, and the line or lines around a range, clipped at whole tokens. */
class LineCounter {
  #at = 0;
  #line = 1;

  constructor(readonly text: string) {}

  /** The 1-based line holding offset `at`; offsets asked for only ever grow. */
  lineAt(at: number): number {
    if (at < this.#at) [this.#at, this.#line] = [0, 1];
    for (let i = this.text.indexOf('\n', this.#at); i >= 0 && i < at; i = this.text.indexOf('\n', i + 1)) this.#line += 1;
    this.#at = at;
    return this.#line;
  }

  /** The whole lines holding `from` to `to`, with at most `CONTEXT / 2` characters each side of the range. */
  around(from: number, to: number): string {
    const text = this.text;
    const start = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
    // A range ending in a line break ends there.
    let end = to > from && text[to - 1] === '\n' ? to : text.indexOf('\n', to);
    if (end < 0) end = text.length;
    // Cut at a token's edge when the context holds one, else mid-token, never inside a surrogate pair.
    const raw = Math.max(start, from - CONTEXT / 2);
    let s = raw;
    while (s < from && isWord(text, s)) s += 1;
    if (s === from && s > raw) s = raw;
    while (s < from && isLowSurrogate(text, s)) s += 1;
    const rawEnd = Math.min(end, to + CONTEXT / 2);
    let e = rawEnd;
    while (e > to && isWord(text, e)) e -= 1;
    if (e === to && e < rawEnd) e = rawEnd;
    while (e > to && isLowSurrogate(text, e)) e -= 1;
    return `${s > start ? '…' : ''}${text.slice(s, e)}${e < end ? '…' : ''}`;
  }
}

const pairsOf = (value: unknown): [string, unknown][] =>
  Array.isArray(value) ? (value as unknown[]).filter((p): p is [string, unknown] => Array.isArray(p) && typeof p[0] === 'string') : [];

/** A payload's text as pieces, from its `text` and the id each run of it starts at (apply.ts `payloadValueOf`). */
function payloadPieces(value: unknown): { pieces: Piece[]; text: string } {
  if (!isObject(value)) return { pieces: [], text: '' };
  const text = value.text;
  const ids = Array.isArray(value.ids) ? (value.ids as unknown[]) : [];
  const out: Piece[] = [];
  const parts: string[] = [];
  let at = 0;
  let offset = 0;
  ids.forEach((pair, n) => {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') return;
    const len: unknown = pair[1];
    // A run length that is not a count (never so from a projection, but hashed as such) is read as it stands.
    if (typeof len !== 'number' || !Number.isSafeInteger(len) || len < 0) {
      out.push(piece({ id: pair[0], len: 1, node: pair, owner: null, at: offset }));
      return;
    }
    const part = typeof text === 'string' ? text.slice(at, at + len) : Array.isArray(text) ? text[n] : undefined;
    at += len;
    if (typeof part !== 'string') out.push(piece({ id: pair[0], len: 1, node: part, owner: null, at: offset }));
    else if (part.length) {
      out.push(piece({ id: pair[0], len: part.length, s: part, owner: null, at: offset }));
      parts.push(part);
      offset += part.length;
    }
  });
  // Text past what the id runs cover (never so in Yjs, but hashed as such) is still read.
  if (typeof text === 'string' && at < text.length) {
    const rest = text.slice(at);
    out.push(piece({ id: '?', client: `${OPAQUE}?`, clock: 0, len: rest.length, s: rest, owner: null, at: offset }));
    parts.push(rest);
  }
  return { pieces: out, text: parts.join('') };
}

/** Where a hunk sits, with a fingerprint of the whole hunk, so rows of two different hunks never read the same. */
function whereOf(hunk: Hunk): string {
  const at = hunk.op === 'added' && hunk.kind === 'block' ? ` after ${hunk.at ?? 'start'}` : '';
  return `${hunk.kind} ${hunk.id} ${hunk.op}${at} #${previewHash([hunk]).slice(0, 12)}`;
}

/**
 * The hunks in reading order: an added block right after the block it follows when that block is also in the list
 * (so new lines read top to bottom), every other hunk in hash order. A reordering only: every hunk stays.
 */
function readingOrder(hunks: readonly Hunk[]): Hunk[] {
  const blocks = new Set(hunks.filter((h) => h.kind === 'block').map((h) => h.id));
  const followers = new Map<string, Hunk[]>();
  const top: Hunk[] = [];
  for (const hunk of hunks) {
    const anchor = hunk.kind === 'block' && hunk.op === 'added' ? hunk.at : null;
    if (anchor && anchor !== hunk.id && blocks.has(anchor)) {
      const list = followers.get(anchor);
      if (list) list.push(hunk);
      else followers.set(anchor, [hunk]);
    } else top.push(hunk);
  }
  const out: Hunk[] = [];
  const placed = new Set<Hunk>();
  // Depth first, without recursion: a chain of thousands of new blocks is one long path.
  const place = (start: Hunk) => {
    const stack = [start];
    while (stack.length > 0) {
      const hunk = stack.pop()!;
      if (placed.has(hunk)) continue;
      placed.add(hunk);
      out.push(hunk);
      const next = hunk.kind === 'block' ? followers.get(hunk.id) : undefined;
      if (next) for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
    }
  };
  top.forEach(place);
  // A cycle of anchors (never from a real doc) still shows every hunk.
  for (const hunk of hunks) place(hunk);
  return out;
}

/** Every row a card shows for `hunks`, in reading order: each hunk yields at least one, and nothing is folded away. */
export function describeHunks(hunks: readonly Hunk[]): ReviewRow[] {
  describeStats.calls += 1;
  const out: ReviewRow[] = [];
  const read = new Reader();
  for (const hunk of readingOrder(hunks)) {
    const before = hunk.op === 'added' ? undefined : hunk.before;
    const after = hunk.op === 'removed' ? undefined : hunk.after;
    const rows = new Rows(whereOf(hunk), read);
    if (hunk.kind === 'note') rows.keys('', 'Note settings', before, after);
    else if (hunk.kind === 'payload') rows.payload(before, after);
    else if (hunk.op === 'changed') rows.value('', before, after);
    else rows.whole(hunk.op === 'added' ? 'insert' : 'delete', '', hunk.op === 'added' ? after : before);
    // A hunk always says something, even when its two values read the same.
    if (rows.out.length === 0) rows.push('change', '', 'Change', `${show(before)} → ${show(after)}`, { before: before ?? null, after: after ?? null });
    for (const row of rows.out) out.push(row);
  }
  return out;
}

const described = new Map<string, ReviewRow[]>();
/** Previews whose rows are kept, most recent last. */
const DESCRIBED = 32;

/**
 * A preview's rows, built once per preview hash (the hash covers every hunk, and the rows are a function of the
 * hunks). The rows are shared: never mutate them.
 */
export function describePreview(preview: { hash: string; hunks: readonly Hunk[] }): ReviewRow[] {
  let rows = described.get(preview.hash);
  if (rows) described.delete(preview.hash);
  else rows = describeHunks(preview.hunks);
  described.set(preview.hash, rows);
  if (described.size > DESCRIBED) described.delete(described.keys().next().value!);
  return rows;
}

/** A piece of a row's text as drawn: plain text, or a run of whitespace (`space`, its exact characters) drawn as glyphs. */
export interface RowSegment {
  text: string;
  space?: string;
}

// Whitespace and invisible characters, and the glyph each is drawn as.
const INVISIBLE = /[\s\u00ad\u180e\u200b-\u200f\u2060\ufeff]+/gu;
const GLYPHS: ReadonlyMap<string, string> = new Map([[' ', '·'], ['\t', '→'], ['\n', '↵'], ['\u00a0', '⍽']]);
const glyph = (ch: string) => GLYPHS.get(ch) ?? `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;

/**
 * A row's text in segments, losslessly: whitespace a reader could not see in plain text (at either end, a run of
 * more than one, anything but a space, or the whole text) is a marked segment of glyphs; one space between words
 * stays plain. Joining each segment's `space ?? text` gives the text back.
 */
export function rowSegments(text: string): RowSegment[] {
  const out: RowSegment[] = [];
  const plain = (part: string) => {
    if (!part) return;
    const last = out.at(-1);
    if (last && last.space === undefined) last.text += part;
    else out.push({ text: part });
  };
  let at = 0;
  for (const match of text.matchAll(INVISIBLE)) {
    const run = match[0];
    const start = match.index;
    plain(text.slice(at, start));
    at = start + run.length;
    if (run === ' ' && start > 0 && at < text.length) plain(run);
    else out.push({ text: [...run].map(glyph).join(''), space: run });
  }
  plain(text.slice(at));
  return out;
}
