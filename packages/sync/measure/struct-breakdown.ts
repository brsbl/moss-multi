// Measurement only (scripts/measure-memory.mjs): what a note's decoded Y.Doc is made of. Counts every struct by kind,
// names each map entry by the Lexical node type that owns it and whether it holds that type's default value (the value a
// fresh `new klass()` has, which is what @lexical/yjs builds a node from before applying the entries it finds), lists the
// exact structs of one node of each type, and rebuilds the note's body with fewer structs so their heap can be measured.
import * as Y from 'yjs';

/** Each Lexical node type's default property values, as @lexical/yjs computes them (`binding.nodeProperties`). */
export type Defaults = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

// Any shared type: Y.Map, Y.XmlText and Y.XmlElement differ in their event type parameter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Type = Y.AbstractType<any>;

export function typeKind(type: Type): string {
  if (type instanceof Y.XmlText) return 'XmlText';
  if (type instanceof Y.XmlElement) return 'XmlElement';
  if (type instanceof Y.XmlHook) return 'XmlHook';
  if (type instanceof Y.XmlFragment) return 'XmlFragment';
  if (type instanceof Y.Map) return 'Map';
  if (type instanceof Y.Array) return 'Array';
  if (type instanceof Y.Text) return 'Text';
  return 'AbstractType';
}

/** A struct's kind: GC, Skip, or an Item by its content (a ContentType by the shared type it holds). */
export function structKind(struct: Y.AbstractStruct): string {
  if (struct instanceof Y.GC) return 'GC';
  if (struct instanceof Y.Skip) return 'Skip';
  const item = struct as Y.Item;
  const content = item.content;
  const entry = item.parentSub === null ? '' : ' (map entry)';
  if (content instanceof Y.ContentType) return `ContentType ${typeKind(content.type as Type)}${entry}`;
  if (content instanceof Y.ContentAny) return `ContentAny${entry || ' (sequence)'}`;
  if (content instanceof Y.ContentString) return 'ContentString';
  if (content instanceof Y.ContentFormat) return 'ContentFormat';
  if (content instanceof Y.ContentEmbed) return 'ContentEmbed';
  if (content instanceof Y.ContentDeleted) return `ContentDeleted${entry}`;
  if (content instanceof Y.ContentJSON) return `ContentJSON${entry}`;
  if (content instanceof Y.ContentBinary) return `ContentBinary${entry}`;
  if (content instanceof Y.ContentDoc) return `ContentDoc${entry}`;
  return 'Item (other content)';
}

/** The live value of a map entry or attribute, or undefined. */
function liveValue(type: Type, key: string): unknown {
  const item = type._map.get(key);
  if (!item || item.deleted) return undefined;
  const content = item.content.getContent();
  return content[content.length - 1];
}

/** The Lexical node type a shared type stands for (its `__type`), or where it hangs when it has none. */
export function ownerName(type: Type): string {
  const named = liveValue(type, '__type');
  if (typeof named === 'string') return named;
  const item = type._item;
  if (item === null) return `top-level ${Y.findRootTypeKey(type)}`;
  if (item.parentSub !== null) return `${ownerName(item.parent as Type)}.${item.parentSub}`;
  return `untyped ${typeKind(type)}`;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether `owner`'s property `key` holds the value a fresh node of that type has. `__type` is never a default. */
export function isDefault(defaults: Defaults, owner: string, key: string, value: unknown): boolean {
  if (key === '__type') return false;
  const fresh = defaults.get(owner);
  return fresh !== undefined && Object.prototype.hasOwnProperty.call(fresh, key) && same(value, fresh[key]);
}

const bump = (counts: Record<string, number>, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

export interface Breakdown {
  structs: number;
  /** Structs by kind. */
  kinds: Record<string, number>;
  /** Items marked deleted (their content is ContentDeleted once collected). */
  deletedItems: number;
  /** Live shared types embedded in a parent, by Lexical node type and Yjs type. */
  nodes: Record<string, number>;
  /** Live map entries and attributes by `owner.key`: how many, and how many hold the owner's default. */
  entries: Record<string, { count: number; defaults: number }>;
  totals: { liveEntries: number; typeKeys: number; defaultEntries: number; textRuns: number; blocks: number };
}

/** Every struct of `doc`, by kind, plus its live map entries by owner and key. */
export function breakdown(doc: Y.Doc, defaults: Defaults): Breakdown {
  const kinds: Record<string, number> = {};
  const nodes: Record<string, number> = {};
  const entries: Record<string, { count: number; defaults: number }> = {};
  const totals = { liveEntries: 0, typeKeys: 0, defaultEntries: 0, textRuns: 0, blocks: 0 };
  let structs = 0;
  let deletedItems = 0;
  for (const list of doc.store.clients.values()) {
    for (const struct of list) {
      structs += 1;
      bump(kinds, structKind(struct));
      if (!(struct instanceof Y.Item)) continue;
      if (struct.deleted) {
        deletedItems += 1;
        continue;
      }
      const content = struct.content;
      if (content instanceof Y.ContentType && struct.parentSub === null) {
        const type = content.type as Type;
        bump(nodes, `${ownerName(type)} (${typeKind(type)})`);
        if (type instanceof Y.XmlText || type instanceof Y.XmlElement) totals.blocks += 1;
        else if (type instanceof Y.Map && liveValue(type, '__type') !== 'linebreak') totals.textRuns += 1;
      }
      if (struct.parentSub === null) continue;
      const owner = ownerName(struct.parent as Type);
      const key = `${owner}.${struct.parentSub}`;
      const entry = (entries[key] ??= { count: 0, defaults: 0 });
      entry.count += 1;
      totals.liveEntries += 1;
      if (struct.parentSub === '__type') totals.typeKeys += 1;
      else if (!(content instanceof Y.ContentType)) {
        const values = content.getContent();
        if (isDefault(defaults, owner, struct.parentSub, values[values.length - 1])) {
          entry.defaults += 1;
          totals.defaultEntries += 1;
        }
      }
    }
  }
  return { structs, kinds, deletedItems, nodes, entries, totals };
}

const show = (value: unknown): string => {
  if (value instanceof Y.AbstractType) return `<${typeKind(value as Type)}>`;
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
};

interface Listing {
  lines: string[];
  structs: number;
}

/** The structs one shared type holds: its own item, each entry (live and overwritten), then its sequence. */
function describe(type: Type, defaults: Defaults, depth: number, recurse: boolean): Listing {
  const pad = '  '.repeat(depth);
  const owner = ownerName(type);
  const top = type._item === null;
  const lines = [top ? `${pad}${owner}: a top-level ${typeKind(type)}, no struct of its own` : `${pad}${owner}: ContentType ${typeKind(type)} (1 struct)`];
  let structs = top ? 0 : 1;
  for (const [key, item] of type._map) {
    for (let old = item.left; old !== null; old = old.left) {
      lines.push(`${pad}  .${key}: overwritten, ${structKind(old)} (1 struct)`);
      structs += 1;
    }
    if (item.deleted) {
      lines.push(`${pad}  .${key}: deleted, ${structKind(item)} (1 struct)`);
      structs += 1;
      continue;
    }
    const value = item.content.getContent()[item.length - 1];
    const tag = key === '__type' ? ', type key' : isDefault(defaults, owner, key, value) ? ', DEFAULT' : '';
    if (item.content instanceof Y.ContentType) {
      const nested = describe(item.content.type as Type, defaults, depth + 2, true);
      lines.push(`${pad}  .${key} = (map entry holding a shared type)`, ...nested.lines);
      structs += nested.structs;
    } else {
      lines.push(`${pad}  .${key} = ${show(value)}: ${structKind(item)}${tag} (1 struct)`);
      structs += 1;
    }
  }
  if (!recurse) {
    // Only the type's own structs: its children are listed under their own types.
    const children: Record<string, number> = {};
    for (let item = type._start; item !== null; item = item.right) {
      const content = item.content;
      const name = content instanceof Y.ContentType && !item.deleted ? `${ownerName(content.type as Type)} (${structKind(item)})` : structKind(item);
      bump(children, name);
    }
    const summary = Object.entries(children).map(([name, count]) => `${count} ${name}`).join(', ');
    if (summary) lines.push(`${pad}  children, not counted here: ${summary}`);
    return { lines, structs };
  }
  for (let item = type._start; item !== null; item = item.right) {
    const content = item.content;
    if (item.deleted) {
      lines.push(`${pad}  [deleted ${item.length}]: ${structKind(item)} (1 struct)`);
      structs += 1;
    } else if (content instanceof Y.ContentType) {
      const child = describe(content.type as Type, defaults, depth + 1, true);
      lines.push(...child.lines);
      structs += child.structs;
    } else if (content instanceof Y.ContentString) {
      lines.push(`${pad}  ${show(content.str)}: ContentString, ${content.str.length} chars (1 struct)`);
      structs += 1;
    } else if (content instanceof Y.ContentFormat) {
      lines.push(`${pad}  format ${content.key} = ${show(content.value)}: ContentFormat (1 struct)`);
      structs += 1;
    } else {
      lines.push(`${pad}  ${structKind(item)} (1 struct)`);
      structs += 1;
    }
  }
  return { lines, structs };
}

export interface Sample {
  label: string;
  structs: number;
  lines: string[];
}

/**
 * The exact structs of the first node of each kind in the body: a top-level paragraph with one text run, a list item,
 * a table cell and a formatted text run whole (children included), and every other node type's own structs.
 */
export function samples(doc: Y.Doc, defaults: Defaults): Sample[] {
  const found = new Map<string, Sample>();
  const add = (label: string, type: Type, recurse: boolean) => {
    if (found.has(label)) return;
    const listing = describe(type, defaults, 0, recurse);
    found.set(label, { label, ...listing });
  };
  const visit = (type: Type, depth: number) => {
    for (let item = type._start; item !== null; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const child = item.content.type as Type;
      const owner = ownerName(child);
      const runs = [...childTypes(child)].filter((t) => t instanceof Y.Map);
      if (owner === 'paragraph' && depth === 0 && runs.length === 1 && childTypes(child).length === 1) add('paragraph with one text run (whole)', child, true);
      if (owner === 'listitem') add('list item (whole)', child, true);
      if (owner === 'tablecell') add('table cell (whole)', child, true);
      if (child instanceof Y.Map) {
        const format = liveValue(child, '__format');
        if (typeof format === 'number' && format !== 0) {
          const string = item.right && !item.right.deleted && item.right.content instanceof Y.ContentString ? item.right.content.str : null;
          if (!found.has('formatted text run (map and its text)')) {
            const listing = describe(child, defaults, 0, false);
            if (string !== null) listing.lines.push(`${show(string)}: ContentString, ${string.length} chars (1 struct)`);
            found.set('formatted text run (map and its text)', { label: 'formatted text run (map and its text)', lines: listing.lines, structs: listing.structs + (string === null ? 0 : 1) });
          }
        }
      }
      add(`${owner} (${typeKind(child)}) own structs`, child, false);
      visit(child, depth + 1);
    }
  };
  const root = doc.get('root', Y.XmlText) as unknown as Type;
  add('root (XmlText) own structs', root, false);
  visit(root, 0);
  return [...found.values()];
}

function childTypes(type: Type): Type[] {
  const out: Type[] = [];
  for (let item = type._start; item !== null; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentType) out.push(item.content.type as Type);
  }
  return out;
}

/** How a rebuilt body differs from the note's. */
export interface Rebuild {
  /** Leave out every entry that holds its node type's default value (`__type` stays). */
  dropDefaults?: boolean;
  /** Leave out a text run's `__type` when it is `text`. */
  dropTextType?: boolean;
  /** A text run becomes its string with Yjs formatting attributes for its non-default entries, without a Y.Map. */
  textAsFormat?: boolean;
  /** After decoding, each ContentAny's array sized to its length (no change to the encoding). */
  exactArrays?: boolean;
  /** After decoding, one string per map key for every entry and every parent's key index (no change to the encoding). */
  sharedKeys?: boolean;
}

/**
 * What a Yjs decoder could hold for the same encoding. Its ContentAny reader pushes onto `[]`, which V8 backs with room
 * for 17 values however few arrive; and it reads every map key as a fresh string, held by the item and its parent's
 * key index.
 */
export function compactDecoded(doc: Y.Doc, { exactArrays = false, sharedKeys = false }: Rebuild): void {
  if (!exactArrays && !sharedKeys) return;
  const keys = new Map<string, string>();
  const share = (key: string) => {
    const known = keys.get(key);
    if (known !== undefined) return known;
    keys.set(key, key);
    return key;
  };
  const parents = new Set<Type>();
  for (const structs of doc.store.clients.values()) {
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      if (exactArrays && struct.content instanceof Y.ContentAny) struct.content.arr = struct.content.arr.slice();
      if (sharedKeys && struct.parentSub !== null) {
        struct.parentSub = share(struct.parentSub);
        parents.add(struct.parent as Type);
      }
    }
  }
  for (const parent of parents) {
    const entries = [...parent._map];
    parent._map.clear();
    for (const [key, item] of entries) parent._map.set(share(key), item);
  }
}

function copyEntries(from: Type, to: Type, defaults: Defaults, options: Rebuild): void {
  const owner = ownerName(from);
  for (const [key, item] of from._map) {
    if (item.deleted) continue;
    let value: unknown;
    if (item.content instanceof Y.ContentType) value = copyType(item.content.type as Type, defaults, options);
    else {
      const values = item.content.getContent();
      value = values[values.length - 1];
      if (options.dropDefaults && isDefault(defaults, owner, key, value)) continue;
      if (options.dropTextType && key === '__type' && value === 'text' && from instanceof Y.Map) continue;
    }
    if (to instanceof Y.Map) to.set(key, value);
    else (to as unknown as Y.XmlText).setAttribute(key, value as string);
  }
}

/** A run's Yjs formatting attributes: its non-default entries, and its type unless it is `text`. */
function runAttributes(map: Type, defaults: Defaults): Record<string, unknown> {
  const owner = ownerName(map);
  const attributes: Record<string, unknown> = {};
  for (const [key, item] of map._map) {
    if (item.deleted || item.content instanceof Y.ContentType) continue;
    const values = item.content.getContent();
    const value = values[values.length - 1];
    if (key === '__type' ? value === 'text' : isDefault(defaults, owner, key, value)) continue;
    attributes[key] = value;
  }
  return attributes;
}

type Op = { insert: unknown; attributes?: Record<string, unknown> };

function childOps(from: Type, defaults: Defaults, options: Rebuild): Op[] {
  const ops: Op[] = [];
  let run: Record<string, unknown> | null = null;
  for (let item = from._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentString) {
      ops.push(run ? { insert: content.str, attributes: { ...run } } : { insert: content.str });
    } else if (content instanceof Y.ContentType) {
      const type = content.type as Type;
      run = null;
      if (options.textAsFormat && type instanceof Y.Map && liveValue(type, '__type') !== 'linebreak') {
        run = runAttributes(type, defaults);
        continue;
      }
      ops.push({ insert: copyType(type, defaults, options) });
    } else if (content instanceof Y.ContentEmbed) {
      run = null;
      ops.push({ insert: content.embed });
    }
  }
  return ops;
}

/** A not-yet-integrated copy of `from`: its entries first, then its children, as @lexical/yjs writes a new node. */
function copyType(from: Type, defaults: Defaults, options: Rebuild): Type {
  if (from instanceof Y.XmlText) {
    const to = new Y.XmlText();
    copyEntries(from, to as unknown as Type, defaults, options);
    const ops = childOps(from, defaults, options);
    if (ops.length) to.applyDelta(ops);
    return to as unknown as Type;
  }
  if (from instanceof Y.XmlElement) {
    const to = new Y.XmlElement(from.nodeName);
    copyEntries(from, to as unknown as Type, defaults, options);
    const children = from.toArray().map((child) => copyType(child as unknown as Type, defaults, options));
    if (children.length) to.insert(0, children as never);
    return to as unknown as Type;
  }
  if (from instanceof Y.Map) {
    const to = new Y.Map<unknown>();
    copyEntries(from, to as unknown as Type, defaults, options);
    return to as unknown as Type;
  }
  throw new Error(`rebuild: a ${typeKind(from)} in the body`);
}

/** The note's body rebuilt with `options`, encoded and decoded into a fresh doc, as the DocDO holds a note. */
export function rebuildBody(source: Y.Doc, defaults: Defaults, options: Rebuild): Y.Doc {
  const built = new Y.Doc();
  try {
    const from = source.get('root', Y.XmlText) as unknown as Type;
    const to = built.get('root', Y.XmlText);
    built.transact(() => {
      copyEntries(from, to as unknown as Type, defaults, options);
      const ops = childOps(from, defaults, options);
      if (ops.length) to.applyDelta(ops);
    });
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, Y.encodeStateAsUpdate(built));
    compactDecoded(decoded, options);
    return decoded;
  } finally {
    built.destroy();
  }
}

/** One synthetic block of each shape the per-kind measurement holds `n` of, so a shape adds exactly one kind. */
export const SHAPES: Record<string, (i: number) => Type> = {
  // An empty block: one ContentType XmlText.
  'XmlText': () => new Y.XmlText() as unknown as Type,
  // Plus one entry (the block's type key).
  'XmlText + 1 entry': () => {
    const block = new Y.XmlText();
    block.setAttribute('__type', 'paragraph');
    return block as unknown as Type;
  },
  // Plus a paragraph's seven entries as @lexical/yjs writes them.
  'XmlText + 7 entries': () => paragraphBlock(true),
  // Plus one text string.
  'XmlText + string': (i) => {
    const block = new Y.XmlText();
    block.insert(0, `Line ${i} of the note.`);
    return block as unknown as Type;
  },
  // Plus one empty Y.Map embedded in the block.
  'XmlText + Map': () => {
    const block = new Y.XmlText();
    block.insertEmbed(0, new Y.Map());
    return block as unknown as Type;
  },
  // Plus a Y.Map holding a text run's five entries.
  'XmlText + Map + 5 entries': () => {
    const block = new Y.XmlText();
    block.insertEmbed(0, textMap(true));
    return block as unknown as Type;
  },
  // A string with one formatting attribute: two ContentFormat structs around it.
  'XmlText + formatted string': (i) => {
    const block = new Y.XmlText();
    block.insert(0, `Line ${i} of the note.`, { __format: 1 });
    return block as unknown as Type;
  },
  // An empty decorator element.
  'XmlElement': () => new Y.XmlElement('decorator') as unknown as Type,
  // A paragraph with one text run, as @lexical/yjs writes it (15 structs).
  'paragraph as written': (i) => {
    const block = paragraphBlock(true);
    (block as unknown as Y.XmlText).applyDelta([{ insert: textMap(true) }, { insert: `Line ${i} of the note.` }]);
    return block;
  },
  // The same paragraph without its default-valued entries (5 structs).
  'paragraph, defaults left out': (i) => {
    const block = paragraphBlock(false);
    (block as unknown as Y.XmlText).applyDelta([{ insert: textMap(false) }, { insert: `Line ${i} of the note.` }]);
    return block;
  },
};

function paragraphBlock(withDefaults: boolean): Type {
  const block = new Y.XmlText();
  block.setAttribute('__type', 'paragraph');
  if (withDefaults) {
    block.setAttribute('__format', 0 as never);
    block.setAttribute('__style', '');
    block.setAttribute('__indent', 0 as never);
    block.setAttribute('__dir', null as never);
    block.setAttribute('__textFormat', 0 as never);
    block.setAttribute('__textStyle', '');
  }
  return block as unknown as Type;
}

function textMap(withDefaults: boolean): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('__type', 'text');
  if (withDefaults) {
    map.set('__format', 0);
    map.set('__style', '');
    map.set('__mode', 0);
    map.set('__detail', 0);
  }
  return map;
}

/** A shape name's suffix: the decoded doc with exact-size ContentAny arrays and shared keys (compactDecoded). */
export const COMPACTED = ', compacted';

/** Every shape the per-kind measurement holds: each of SHAPES, then the compacted ones it compares them with. */
export const SHAPE_NAMES = [
  ...Object.keys(SHAPES),
  ...['XmlText + 1 entry', 'XmlText + 7 entries', 'XmlText + Map + 5 entries', 'paragraph as written', 'paragraph, defaults left out'].map((name) => `${name}${COMPACTED}`),
];

/** `n` blocks of `shape` under the root, encoded and decoded into a fresh doc. */
export function syntheticDoc(shape: string, n: number): Y.Doc {
  const compacted = shape.endsWith(COMPACTED);
  const make = SHAPES[compacted ? shape.slice(0, -COMPACTED.length) : shape];
  if (!make) throw new Error(`no shape ${shape}`);
  const built = new Y.Doc();
  try {
    const root = built.get('root', Y.XmlText);
    const ops: Op[] = [];
    for (let i = 0; i < n; i += 1) ops.push({ insert: make(i) });
    root.applyDelta(ops);
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, Y.encodeStateAsUpdate(built));
    if (compacted) compactDecoded(decoded, { exactArrays: true, sharedKeys: true });
    return decoded;
  } finally {
    built.destroy();
  }
}
