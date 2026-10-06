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
    tokens.push({ align: `\u0000${type}`, display: tokens.length ? '\n' : '', fields: own, sig: canonical(own.map((f) => [f.field, f.value])) });
    for (const child of children) walk(child, [], depth + 1);
  };
  for (const child of Array.isArray(block.children) ? (block.children as unknown[]).filter(isObject) : []) walk(child, [], 1);
  return tokens;
}

const displayOf = (tokens: readonly Token[]) => tokens.map((t) => t.display).join('');

/** What a run carries beyond plain text: its formatting, its link, a decorator's fields. */
function carried(fields: readonly Field[]): string | undefined {
  const parts = fields
    .filter((f) => !isDefault(f.field.split(':')[2], f.value) && !(f.field.endsWith(':type') && f.value === 'text'))
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
    for (const run of runs(before ? b : a, (t) => t.sig)) {
      const note = run[0].align.startsWith('\u0000') ? undefined : carried(run[0].fields);
      if (note) rows.push({ kind, text: displayOf(run), note });
    }
    return rows;
  }
  let start = 0;
  while (start < b.length && start < a.length && b[start].align === a[start].align) start += 1;
  let end = 0;
  while (end < b.length - start && end < a.length - start && b[b.length - 1 - end].align === a[a.length - 1 - end].align) end += 1;
  // The block's own fields: its type, indent, alignment, a list's kind, a checkbox.
  const ownOf = (node: Json) => ownFields(node).map(([field, value]) => ({ label: field === 'type' ? 'block' : `${blockType(node)} ${field}`, field: `0:block:${field}`, value }));
  const own = fieldChanges(ownOf(before), ownOf(after));
  if (own) rows.push({ kind: 'change', text: displayOf(a).trim() || blockType(after), note: own });
  // Removed and added, run by run, each with what it carries.
  for (const run of runs(b.slice(start, b.length - end), (t) => t.sig)) rows.push({ kind: 'delete', text: displayOf(run), note: carried(run[0].fields) });
  for (const run of runs(a.slice(start, a.length - end), (t) => t.sig)) rows.push({ kind: 'insert', text: displayOf(run), note: carried(run[0].fields) });
  // Kept text whose formatting, link or node fields changed.
  const pairs: [Token, Token][] = [];
  for (let i = 0; i < start; i++) pairs.push([b[i], a[i]]);
  for (let i = end; i > 0; i--) pairs.push([b[b.length - i], a[a.length - i]]);
  const changed = pairs.filter(([x, y]) => x.sig !== y.sig);
  for (const run of runs(changed, ([x, y]) => `${x.sig}\u0002${y.sig}`)) {
    rows.push({ kind: 'change', text: displayOf(run.map(([, y]) => y)), note: fieldChanges(run[0][0].fields, run[0][1].fields) });
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
      if (canonical(yOf(before)) !== canonical(yOf(after)) && (lexicalSame || rows.length === 0)) {
        rows.push(...leafRows(displayOf(tokenize(a ?? b ?? {})).trim() || 'Stored block', yOf(before), yOf(after)));
      }
    }
    if (rows.length === 0) rows = leafRows(hunk.kind === 'note' ? 'Note settings' : 'Change', before, after);
    out.push(...rows);
  }
  return out;
}
