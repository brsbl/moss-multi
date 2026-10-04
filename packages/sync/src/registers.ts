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
type Entries = ReadonlyMap<string, unknown>;
/** A compound payload as one `Y.Map` of independent keys, so concurrent edits to different keys both land. */
interface MapCodec { fields: readonly string[]; encode(fields: Fields): Map<string, unknown>; decode(entries: Entries): Fields }

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

/**
 * `chart.__config` as JSON-pointer keys: `#k<path>` holds an object's key order, `=<path>` a leaf (arrays included).
 * Order lists are last-writer-wins, so a key missing from its object's list still renders, after the listed ones.
 */
const chartCodec: MapCodec = {
  fields: ['__config'],
  encode(fields) {
    const out = new Map<string, unknown>();
    const walk = (value: unknown, path: string) => {
      if (isPlainObject(value)) {
        const keys = Object.keys(value).filter(key => value[key] !== undefined);
        out.set(`#k${path}`, keys.map(segment));
        for (const key of keys) walk(value[key], `${path}/${segment(key)}`);
      } else if (value !== undefined) {
        out.set(`=${path}`, clone(value));
      }
    };
    if (fields.__config !== undefined) walk(fields.__config, '');
    return out;
  },
  decode(entries) {
    if (!entries.has('#k')) return { __config: undefined };
    const children = new Map<string, Set<string>>();
    for (const key of entries.keys()) {
      const path = key.startsWith('#k') ? key.slice(2) : key.startsWith('=') ? key.slice(1) : null;
      if (!path) continue;
      const cut = path.lastIndexOf('/');
      const parent = path.slice(0, cut);
      children.set(parent, (children.get(parent) ?? new Set()).add(path.slice(cut + 1)));
    }
    const build = (path: string): Record<string, unknown> => {
      const present = children.get(path) ?? new Set<string>();
      const listed = ((entries.get(`#k${path}`) as string[] | undefined) ?? []).filter(seg => present.has(seg));
      const order = [...new Set(listed), ...[...present].filter(seg => !listed.includes(seg)).sort()];
      const object: Record<string, unknown> = {};
      for (const seg of order) {
        const child = `${path}/${seg}`;
        object[unsegment(seg)] = entries.has(`#k${child}`) ? build(child) : clone(entries.get(`=${child}`));
      }
      return object;
    };
    return { __config: build('') };
  },
};

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
    for (const [key, value] of entries) {
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
  const after = codec.encode(next);
  const current = codec.decode(map as Y.Map<unknown>);
  const before = codec.encode(base ?? Object.fromEntries(Object.keys(next).map(field => [field, current[field]])));
  doc.transact(() => {
    for (const [key, value] of after) {
      if (before.has(key) && sameValue(before.get(key), value)) continue;
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
  const entries = codec.encode(value);
  const before = codec.encode(from);
  const after = codec.encode(to);
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
