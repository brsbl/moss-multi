// The rows a suggestion card shows for a preview's hunks (docs/design/suggestions.md §4.4): every hunk the hash
// covers, in full. Text a record adds or removes is shown with its formatting; a change to formatting, a link, a
// block's properties, a decorator, a payload's fields or the note's settings is shown with its old and new value.
import { canonical, type Hunk } from './apply.ts';

export interface ReviewRow {
  kind: 'insert' | 'delete' | 'change';
  /** The text the row is about, in full. */
  text: string;
  /** What changed about it, or what it carries (formatting, a link), when that is not plain text. */
  note?: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

const FORMATS: [number, string][] = [
  [1, 'bold'], [2, 'italic'], [4, 'strikethrough'], [8, 'underline'], [16, 'code'], [32, 'subscript'], [64, 'superscript'], [128, 'highlight'],
];

function formatNames(format: number): string {
  const names = FORMATS.filter(([bit]) => (format & bit) !== 0).map(([, name]) => name);
  const rest = format & ~FORMATS.reduce((all, [bit]) => all | bit, 0);
  if (rest) names.push(`format ${rest}`);
  return names.length ? names.join(', ') : 'plain';
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return canonical(value);
}

/** Field values a reader sees as "nothing set", left out of what a run carries. */
const DEFAULTS: Record<string, unknown> = { format: 0, style: '', mode: 'normal', detail: 0, indent: 0, direction: null, textFormat: 0, textStyle: '' };
const isDefault = (field: string, value: unknown) => field in DEFAULTS && (DEFAULTS[field] === value || (DEFAULTS[field] === null && (value === null || value === undefined)));

/** A node's own fields, without its children, its text and its version. */
function ownFields(node: Json): [string, unknown][] {
  return Object.entries(node)
    .filter(([key]) => key !== 'children' && key !== 'text' && key !== 'version')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A field as a reader names it: `type field`, the node type alone for `type`. */
interface Field {
  label: string;
  field: string;
  value: unknown;
}

const fieldText = (field: Field, value = field.value) => (field.field.endsWith(':format') && typeof value === 'number' ? formatNames(value) : show(value));

/** One unit of a block: a character (with the fields of every node above it), an element's start, or a leaf node. */
interface Token {
  /** What aligns with what: the character, or the node kind. */
  align: string;
  /** What a reader sees for it. */
  display: string;
  fields: Field[];
  sig: string;
  /** An element's start: the element's own text, which names it in a row. */
  label?: string;
}

const INLINE_ELEMENTS = new Set(['link', 'autolink']);

function tokenize(block: Json): Token[] {
  const tokens: Token[] = [];
  const walk = (node: Json, chain: Field[], depth: number) => {
    const type = typeof node.type === 'string' ? node.type : 'node';
    const own = ownFields(node).map(([field, value]) => ({ label: field === 'type' ? type : `${type} ${field}`, field: `${depth}:${type}:${field}`, value }));
    const fields = [...chain, ...own];
    if (typeof node.text === 'string') {
      const sig = canonical(fields.map((f) => [f.field, f.value]));
      for (const ch of node.text) tokens.push({ align: ch, display: ch, fields, sig });
      return;
    }
    const children = Array.isArray(node.children) ? (node.children as unknown[]).filter(isObject) : null;
    if (!children) {
      const display = type === 'linebreak' ? '\n' : type === 'tab' ? '\t' : `[${type}]`;
      tokens.push({ align: `\u0001${type}`, display, fields: own, sig: canonical(own.map((f) => [f.field, f.value])) });
      return;
    }
    if (INLINE_ELEMENTS.has(type)) {
      for (const child of children) walk(child, fields, depth + 1);
      return;
    }
    const at = tokens.length;
    tokens.push({ align: `\u0000${type}`, display: tokens.length ? '\n' : '', fields: own, sig: canonical(own.map((f) => [f.field, f.value])) });
    for (const child of children) walk(child, [], depth + 1);
    tokens[at].label = displayOf(tokens.slice(at + 1)).trim() || type;
  };
  for (const child of Array.isArray(block.children) ? (block.children as unknown[]).filter(isObject) : []) walk(child, [], 1);
  return tokens;
}

const displayOf = (tokens: readonly Token[]) => tokens.map((t) => t.display).join('');
/** A run's text: an element's start reads as the element's text. */
const textOf = (tokens: readonly Token[]) => (tokens.every((t) => t.label !== undefined) ? tokens.map((t) => t.label).join(', ') : displayOf(tokens));

/** What a run carries beyond plain text: its formatting, its link, a decorator's fields. */
function carried(fields: readonly Field[]): string | undefined {
  const parts = fields
    .filter((f) => !isDefault(f.field.split(':')[2], f.value) && show(f.value) !== 'none' && !(f.field.endsWith(':type') && f.value === 'text'))
    .map((f) => (f.field.endsWith(':type') ? f.label : f.field.endsWith(':format') ? fieldText(f) : `${f.label}: ${fieldText(f)}`));
  return parts.length ? parts.join('; ') : undefined;
}

/** Each field whose value differs, as `label: old → new`. */
function fieldChanges(before: readonly Field[], after: readonly Field[]): string | undefined {
  const b = new Map(before.map((f) => [f.field, f]));
  const a = new Map(after.map((f) => [f.field, f]));
  const out: string[] = [];
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const was = b.get(key);
    const now = a.get(key);
    if (was && now && canonical(was.value) === canonical(now.value)) continue;
    const field = (now ?? was)!;
    if (field.field.endsWith(':type')) out.push(`${was ? show(was.value) : 'none'} → ${now ? show(now.value) : 'none'}`);
    else out.push(`${field.label}: ${was ? fieldText(field, was.value) : 'none'} → ${now ? fieldText(field, now.value) : 'none'}`);
  }
  return out.length ? out.join('; ') : undefined;
}

/** Consecutive tokens grouped by what they carry. */
function runs<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const out: T[][] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && key(last[0]) === key(item)) last.push(item);
    else out.push([item]);
  }
  return out;
}

/** One step of aligning two token lists: a kept pair, a removed token or an added one. */
type Step = { op: 'keep'; b: Token; a: Token } | { op: 'delete'; b: Token } | { op: 'insert'; a: Token };

/** Above this many cells the changed middle is shown as removed then added, unaligned. */
const ALIGN_CELLS = 1_000_000;

/** `b` aligned with `a` by a longest common subsequence of their tokens, so kept text inside a change stays kept. */
function align(b: readonly Token[], a: readonly Token[]): Step[] {
  let start = 0;
  while (start < b.length && start < a.length && b[start].align === a[start].align) start += 1;
  let end = 0;
  while (end < b.length - start && end < a.length - start && b[b.length - 1 - end].align === a[a.length - 1 - end].align) end += 1;
  const steps: Step[] = [];
  for (let i = 0; i < start; i++) steps.push({ op: 'keep', b: b[i], a: a[i] });
  const mb = b.slice(start, b.length - end);
  const ma = a.slice(start, a.length - end);
  if (mb.length * ma.length > ALIGN_CELLS) {
    for (const t of mb) steps.push({ op: 'delete', b: t });
    for (const t of ma) steps.push({ op: 'insert', a: t });
  } else {
    const n = mb.length;
    const m = ma.length;
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] = mb[i].align === ma[j].align ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && mb[i].align === ma[j].align) steps.push({ op: 'keep', b: mb[i++], a: ma[j++] });
      else if (j >= m || (i < n && lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1])) steps.push({ op: 'delete', b: mb[i++] });
      else steps.push({ op: 'insert', a: ma[j++] });
    }
  }
  for (let k = end; k > 0; k--) steps.push({ op: 'keep', b: b[b.length - k], a: a[a.length - k] });
  return steps;
}

function blockRows(before: Json | null, after: Json | null): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const b = before ? tokenize(before) : [];
  const a = after ? tokenize(after) : [];
  const blockType = (node: Json) => (typeof node.type === 'string' ? node.type : 'block');
  if (!before || !after) {
    const node = (before ?? after)!;
    const kind = before ? 'delete' : 'insert';
    const own = ownFields(node).map(([field, value]) => ({ label: field === 'type' ? blockType(node) : `${blockType(node)} ${field}`, field: `0:${blockType(node)}:${field}`, value }));
    rows.push({ kind, text: displayOf(before ? b : a), note: `${before ? 'removes' : 'new'} ${carried(own) ?? blockType(node)}` });
    // Each run with what it carries, and each nested element (a list item, a cell) with its own fields.
    for (const run of runs(before ? b : a, (t) => t.sig)) {
      const note = carried(run[0].fields);
      if (note) rows.push({ kind, text: textOf(run), note });
    }
    return rows;
  }
  // The block's own fields: its type, indent, alignment, a list's kind, a checkbox.
  const ownOf = (node: Json) => ownFields(node).map(([field, value]) => ({ label: field === 'type' ? 'block' : `${blockType(node)} ${field}`, field: `0:block:${field}`, value }));
  const own = fieldChanges(ownOf(before), ownOf(after));
  if (own) rows.push({ kind: 'change', text: displayOf(a).trim() || blockType(after), note: own });
  // In document order: removed and added runs with what they carry, and kept text or elements whose fields changed.
  const keyOf = (step: Step) =>
    step.op === 'keep' ? (step.b.sig === step.a.sig ? null : `k\u0002${step.b.sig}\u0002${step.a.sig}`) : step.op === 'delete' ? `d\u0002${step.b.sig}` : `i\u0002${step.a.sig}`;
  const groups: Step[][] = [];
  let last: string | null = null;
  for (const step of align(b, a)) {
    const key = keyOf(step);
    if (key === null) {
      last = null;
      continue;
    }
    if (key === last) groups.at(-1)!.push(step);
    else groups.push([step]);
    last = key;
  }
  for (const group of groups) {
    const first = group[0];
    if (first.op === 'delete') {
      const run = group.map((step) => (step as { b: Token }).b);
      rows.push({ kind: 'delete', text: textOf(run), note: carried(run[0].fields) });
    } else if (first.op === 'insert') {
      const run = group.map((step) => (step as { a: Token }).a);
      rows.push({ kind: 'insert', text: textOf(run), note: carried(run[0].fields) });
    } else {
      const pairs = group as Extract<Step, { op: 'keep' }>[];
      rows.push({ kind: 'change', text: textOf(pairs.map((step) => step.a)), note: fieldChanges(first.b.fields, first.a.fields) });
    }
  }
  return rows.map((row) => (row.note === undefined ? { kind: row.kind, text: row.text } : row));
}

/** Every leaf of `value` by its path. */
function leaves(value: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((item, i) => leaves(item, path ? `${path}.${i}` : String(i), out));
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) leaves(item, path ? `${path}.${key}` : key, out);
  else out.set(path, value);
  return out;
}

/** Every leaf that differs, as `path: old → new`: the last word, so nothing the hash covers goes unshown. */
function leafRows(text: string, before: unknown, after: unknown): ReviewRow[] {
  const b = leaves(before);
  const a = leaves(after);
  const rows: ReviewRow[] = [];
  for (const path of new Set([...b.keys(), ...a.keys()])) {
    if (canonical(b.get(path)) === canonical(a.get(path))) continue;
    rows.push({ kind: 'change', text, note: `${path || 'value'}: ${show(b.get(path))} → ${show(a.get(path))}` });
  }
  return rows;
}

/** The changed middle of two texts. */
function middle(before: string, after: string): { removed: string; added: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { removed: before.slice(start, before.length - end), added: after.slice(start, after.length - end) };
}

const pairsOf = (value: unknown): [string, unknown][] => (Array.isArray(value) ? (value as unknown[]).filter((p): p is [string, unknown] => Array.isArray(p) && typeof p[0] === 'string') : []);

function keyRows(text: string, before: unknown, after: unknown): ReviewRow[] {
  const b = new Map(pairsOf(before));
  const a = new Map(pairsOf(after));
  const rows: ReviewRow[] = [];
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    if (canonical(b.get(key)) === canonical(a.get(key))) continue;
    rows.push({ kind: 'change', text, note: `${key}: ${show(b.get(key))} → ${show(a.get(key))}` });
  }
  return rows;
}

function payloadText(value: unknown): string {
  const text = isObject(value) ? value.text : undefined;
  if (typeof text === 'string') return text;
  return Array.isArray(text) ? text.map((part) => (typeof part === 'string' ? part : `[${show(part)}]`)).join('') : '';
}

function payloadRows(before: unknown, after: unknown): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const { removed, added } = middle(payloadText(before), payloadText(after));
  if (removed) rows.push({ kind: 'delete', text: removed, note: 'block content' });
  if (added) rows.push({ kind: 'insert', text: added, note: 'block content' });
  rows.push(...keyRows('Block content', isObject(before) ? before.map : undefined, isObject(after) ? after.map : undefined));
  return rows;
}

/** Every field name in a Lexical JSON tree. */
function fieldNames(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) fieldNames(item, out);
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      fieldNames(item, out);
    }
  }
  return out;
}

/** A stored key as Lexical's JSON names it: `__indent` is `indent`, `__dir` is `direction`. */
const exportedName = (key: string) => (key === '__dir' ? 'direction' : key.startsWith('__') ? key.slice(2) : key);

/** A stored value as a reader reads it: a Yjs `Any` wrapper unwrapped. */
const storedValue = (value: unknown) => (isObject(value) && Array.isArray(value.Any) && value.Any.length === 1 ? value.Any[0] : value);

/**
 * The stored properties of a block's Yjs value that its Lexical JSON does not show, one list per stored node in order
 * (the block, then each node inside it); anything in a sequence that is neither text nor a node is listed as content.
 */
function hiddenOf(y: unknown, shown: ReadonlySet<string>): [string, unknown][][] {
  const out: [string, unknown][][] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') return;
    if (isObject(value) && typeof value.type === 'string' && (Array.isArray(value.seq) || Array.isArray(value.keys))) {
      out.push(pairsOf(value.keys).filter(([key]) => !shown.has(exportedName(key))).map(([key, item]) => [exportedName(key), storedValue(item)]));
      for (const item of Array.isArray(value.seq) ? value.seq : []) visit(item);
      return;
    }
    out.push([['content', value]]);
  };
  visit(y);
  return out;
}

/** Each stored property Lexical's JSON does not show that differs, node by node, as `name: old → new`. */
function hiddenRows(text: string, before: unknown, after: unknown, lexical: unknown[]): ReviewRow[] {
  const shown = new Set<string>();
  for (const tree of lexical) fieldNames(tree, shown);
  const b = hiddenOf(before, shown);
  const a = hiddenOf(after, shown);
  const same = (x: [string, unknown][], y: [string, unknown][]) => canonical(x) === canonical(y);
  let start = 0;
  while (start < b.length && start < a.length && same(b[start], a[start])) start += 1;
  let end = 0;
  while (end < b.length - start && end < a.length - start && same(b[b.length - 1 - end], a[a.length - 1 - end])) end += 1;
  const rows: ReviewRow[] = [];
  for (let i = start; i < Math.max(b.length, a.length) - end; i++) {
    const was = i < b.length - end ? b[i] : [];
    const now = i < a.length - end ? a[i] : [];
    rows.push(...keyRows(text, was, now).map((row) => ({ ...row, note: `stored ${row.note}` })));
  }
  return rows;
}

const lexicalOf = (value: unknown): Json | null => (isObject(value) && isObject(value.lexical) ? value.lexical : null);
const yOf = (value: unknown): unknown => (isObject(value) ? value.y : undefined);

/** Every row a card shows for `hunks`: each hunk yields at least one, and nothing is folded away. */
export function describeHunks(hunks: readonly Hunk[]): ReviewRow[] {
  const out: ReviewRow[] = [];
  for (const hunk of hunks) {
    const before = hunk.op === 'added' ? undefined : hunk.before;
    const after = hunk.op === 'removed' ? undefined : hunk.after;
    let rows: ReviewRow[];
    if (hunk.kind === 'note') rows = keyRows('Note settings', before, after);
    else if (hunk.kind === 'payload') rows = payloadRows(before, after);
    else {
      const b = lexicalOf(before);
      const a = lexicalOf(after);
      const lexicalSame = canonical(b) === canonical(a);
      rows = lexicalSame || (!b && before !== undefined) || (!a && after !== undefined) ? [] : blockRows(b, a);
      // What Lexical's own fields do not show (a stored property it does not export) is shown as stored.
      if (canonical(yOf(before)) !== canonical(yOf(after))) {
        const text = displayOf(tokenize(a ?? b ?? {})).trim() || 'Stored block';
        if (lexicalSame || rows.length === 0) rows.push(...leafRows(text, yOf(before), yOf(after)));
        else rows.push(...hiddenRows(text, yOf(before), yOf(after), [b, a]));
      }
    }
    if (rows.length === 0) rows = leafRows(hunk.kind === 'note' ? 'Note settings' : 'Change', before, after);
    out.push(...rows);
  }
  return out;
}
