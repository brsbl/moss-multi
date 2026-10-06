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
import { canonical, previewHash, type Hunk } from './apply.ts';

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

/**
 * A row's path one key deeper. Every row below a key repeats its path, so each key is clipped and the path keeps
 * only its last `2 × CONTEXT` characters: a row costs a constant beyond what it covers.
 */
const sub = (path: string, key: string) => {
  const next = `${path} ${clip(key)}`;
  return next.length > 2 * CONTEXT ? `…${next.slice(-(2 * CONTEXT - 1))}` : next;
};

/** One unit of a sequence: a character with its own id, or any other item. */
type Unit = { id: string; ch: string } | { id: string; node: unknown };

const isChar = (unit: Unit): unit is { id: string; ch: string } => 'ch' in unit;

function units(seq: unknown[] | undefined): Unit[] {
  const out: Unit[] = [];
  for (const entry of seq ?? []) {
    if (!isObject(entry)) {
      out.push({ id: '?', node: entry });
      continue;
    }
    const id = typeof entry.id === 'string' ? entry.id : '?';
    if (typeof entry.s === 'string') {
      const [client, clock] = id.split(':').map(Number);
      for (let i = 0; i < entry.s.length; i++) out.push({ id: `${client}:${clock + i}`, ch: entry.s[i] });
    } else {
      out.push({ id, node: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'id')) });
    }
  }
  return out;
}

/** Ids as runs: `client:clock+length`. */
function idRuns(ids: readonly string[]): string {
  const runs: string[] = [];
  let start = '';
  let client = NaN;
  let next = NaN;
  let len = 0;
  const flush = () => {
    if (len) runs.push(len === 1 ? start : `${start}+${len}`);
  };
  for (const id of ids) {
    const [c, k] = id.split(':').map(Number);
    if (c === client && k === next) {
      len += 1;
      next += 1;
      continue;
    }
    flush();
    start = id;
    client = c;
    next = k + 1;
    len = 1;
  }
  flush();
  return runs.join(',');
}

type Step = { op: 'keep'; b: Unit; a: Unit } | { op: 'delete'; b: Unit } | { op: 'insert'; a: Unit };

/** Two sequences aligned by item identity: an item in both is kept, one only before is removed, one only after added. */
function align(b: readonly Unit[], a: readonly Unit[]): Step[] {
  const inA = new Set(a.map((unit) => unit.id));
  const inB = new Set(b.map((unit) => unit.id));
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    if (i < b.length && (j >= a.length || !inA.has(b[i].id))) steps.push({ op: 'delete', b: b[i++] });
    else if (j < a.length && (i >= b.length || !inB.has(a[j].id))) steps.push({ op: 'insert', a: a[j++] });
    else if (b[i].id === a[j].id) {
      // One id holding two different characters (never so in Yjs, but hashed as such) is removed and added.
      const x = b[i];
      const y = a[j];
      if (isChar(x) !== isChar(y) || (isChar(x) && isChar(y) && x.ch !== y.ch)) steps.push({ op: 'delete', b: b[i++] }, { op: 'insert', a: a[j++] });
      else steps.push({ op: 'keep', b: b[i++], a: a[j++] });
    }
    // Out of order (Yjs never moves an item): shown as removed here and added where it now sits.
    else steps.push({ op: 'delete', b: b[i++] });
  }
  return steps;
}

/** Consecutive removed or added units of `steps` from `i`, and where the run ends. */
function runAt(steps: readonly Step[], i: number): { op: 'delete' | 'insert'; run: Unit[]; end: number } {
  const op = steps[i].op as 'delete' | 'insert';
  const run: Unit[] = [];
  let end = i;
  for (; end < steps.length && steps[end].op === op; end++) {
    const step = steps[end] as { op: 'delete'; b: Unit } | { op: 'insert'; a: Unit };
    run.push('b' in step ? step.b : step.a);
  }
  return { op, run, end };
}

type Owner = { id: string; node: Node };

/** Each character's text node: the last map before it in its sequence (Lexical's V1 binding). */
function owners(list: readonly Unit[]): Map<string, Owner> {
  const out = new Map<string, Owner>();
  let owner: Owner | null = null;
  for (const unit of list) {
    if (isChar(unit)) {
      if (owner) out.set(unit.id, owner);
    } else owner = isNode(unit.node) && unit.node.type === 'Map' ? { id: unit.id, node: unit.node } : null;
  }
  return out;
}

/** Each text node's characters, by the id of its map. */
function ownedText(list: readonly Unit[], ownerOf: Map<string, Owner>): Map<string, string> {
  const out = new Map<string, string>();
  for (const unit of list) {
    const owner = isChar(unit) ? ownerOf.get(unit.id) : undefined;
    if (owner && isChar(unit)) out.set(owner.id, (out.get(owner.id) ?? '') + unit.ch);
  }
  return out;
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

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

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
      const list = units(value.seq);
      this.sequence(kind, path, list, [], true, owners(list));
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
   * Units all added or all removed: runs of characters by text node, and every other item. A text node's map whose
   * characters follow it is said by their row. `quiet` leaves out what has nothing to add to an enclosing row.
   */
  sequence(kind: 'insert' | 'delete', path: string, list: readonly Unit[], chain: readonly string[], quiet: boolean, ownerOf: Map<string, Owner>): void {
    for (let i = 0; i < list.length; ) {
      const unit = list[i];
      const map: Owner | null = !isChar(unit) && isNode(unit.node) && unit.node.type === 'Map' ? { id: unit.id, node: unit.node } : null;
      if (!isChar(unit) && !map) {
        this.whole(kind, sub(path, unit.id), unit.node, quiet);
        i += 1;
        continue;
      }
      const owner = map ?? ownerOf.get(unit.id) ?? null;
      // The map, when it is in this run, and the characters of its text node that follow it.
      const run: Unit[] = [];
      if (map) run.push(list[i++]);
      for (; i < list.length; i++) {
        const next = list[i];
        if (!isChar(next) || ownerOf.get(next.id)?.id !== owner?.id) break;
        run.push(next);
      }
      const text = run.map((u) => (isChar(u) ? u.ch : '')).join('');
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
        this.push(kind, path, text, note.join('; ') || undefined, { ids: idRuns(run.map((u) => u.id)), node: map ? shallow(map.node) : (owner?.id ?? null) });
      }
      if (map) this.fields(kind, sub(path, map.id), map.node);
    }
  }

  /** Two versions of one node: each field that differs, then its sequence aligned by identity. */
  node(path: string, b: Node, a: Node, label: string): void {
    const type = this.read.typeName(a);
    const before = new Map(fieldsOf(b));
    const after = new Map(fieldsOf(a));
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const was = before.get(key);
      const now = after.get(key);
      if (this.read.same(was, now)) continue;
      if (isNode(was) && isNode(now) && was.type === now.type) {
        this.node(sub(path, key), was, now, label);
        continue;
      }
      this.push('change', sub(path, key), label, `${clip(type)} ${fieldName(key)}: ${show(was, key, b)} → ${show(now, key, a)}`, { before: was ?? null, after: now ?? null });
    }
    if (this.read.same(b.seq, a.seq)) return;
    // Runs inside a link say so, with the link's fields clipped; the link's own changes have their own rows.
    const inner = this.read.isInline(a) ? [clip([type, ...this.read.carried(a)].join('; '))] : [];
    const bu = units(b.seq);
    const au = units(a.seq);
    const ownB = owners(bu);
    const ownA = owners(au);
    const texts = ownedText(au, ownA);
    const steps = align(bu, au);
    for (let i = 0; i < steps.length; ) {
      const step = steps[i];
      if (step.op === 'keep') {
        if (!isChar(step.b) && !isChar(step.a)) this.value(sub(path, step.a.id), step.b.node, step.a.node, texts.get(step.a.id));
        i += 1;
        continue;
      }
      const { op, run, end } = runAt(steps, i);
      this.sequence(op, path, run, inner, false, op === 'delete' ? ownB : ownA);
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
        this.node(sub(path, key), was, now, text);
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

  /** A payload's two versions: its text aligned by identity, then its fields. */
  payload(before: unknown, after: unknown): void {
    const steps = align(payloadUnits(before), payloadUnits(after));
    for (let i = 0; i < steps.length; ) {
      if (steps[i].op === 'keep') {
        i += 1;
        continue;
      }
      const { op, run, end } = runAt(steps, i);
      i = end;
      for (const unit of run) if (!isChar(unit)) this.push(op, `text ${unit.id}`, show(unit.node), 'block content', unit.node);
      const chars = run.filter(isChar);
      if (chars.length) this.push(op, 'text', chars.map((u) => u.ch).join(''), 'block content', { ids: idRuns(chars.map((u) => u.id)) });
    }
    // Anything else the value holds is compared whole.
    const rest = (value: unknown) =>
      isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'text' && key !== 'ids' && key !== 'map')) : (value ?? {});
    if (!this.read.same(rest(before), rest(after))) {
      this.push('change', '', 'Block content', `${show(rest(before))} → ${show(rest(after))}`, { before: rest(before), after: rest(after) });
    }
    this.keys('map', 'Block content', isObject(before) ? before.map : undefined, isObject(after) ? after.map : undefined);
  }
}

const pairsOf = (value: unknown): [string, unknown][] =>
  Array.isArray(value) ? (value as unknown[]).filter((p): p is [string, unknown] => Array.isArray(p) && typeof p[0] === 'string') : [];

/** A payload's text as units, from its `text` and the id each run of it starts at (apply.ts `payloadValueOf`). */
function payloadUnits(value: unknown): Unit[] {
  if (!isObject(value)) return [];
  const text = value.text;
  const ids = Array.isArray(value.ids) ? (value.ids as unknown[]) : [];
  const out: Unit[] = [];
  let at = 0;
  ids.forEach((pair, n) => {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') return;
    const len: unknown = pair[1];
    // A run length that is not a count (never so from a projection, but hashed as such) is read as it stands.
    if (typeof len !== 'number' || !Number.isSafeInteger(len) || len < 0) {
      out.push({ id: pair[0], node: pair });
      return;
    }
    const [client, clock] = pair[0].split(':').map(Number);
    const part = typeof text === 'string' ? text.slice(at, at + len) : Array.isArray(text) ? text[n] : undefined;
    at += len;
    if (typeof part === 'string') for (let i = 0; i < part.length; i++) out.push({ id: `${client}:${clock + i}`, ch: part[i] });
    else out.push({ id: pair[0], node: part });
  });
  // Text past what the id runs cover (never so in Yjs, but hashed as such) is still read.
  if (typeof text === 'string') for (let i = at; i < text.length; i++) out.push({ id: `?:${i}`, ch: text[i] });
  return out;
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
