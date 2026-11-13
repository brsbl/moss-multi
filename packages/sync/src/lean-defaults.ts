// The lean layout (A§10.11) for an undo: Yjs removes a key outright when an undo takes back the write that first stored
// it, and a client on the earlier binding reads an empty key as `undefined`, not as the class default.
import type { Binding } from '@lexical/yjs';
import { Map as YMap, XmlElement, XmlText, type AbstractType, type Doc, type Item, type Transaction } from 'yjs';

/** Each node type's properties the lean layout leaves out at their default, as the patched binding builds them. */
export type LeanDefaults = ReadonlyMap<string, Readonly<Record<string, unknown>>>;
type LeanBinding = Binding & { leanDefaults?: LeanDefaults };

/** The binding's lean defaults; undefined for a binding without the patch. */
export const leanDefaultsOf = (binding: Binding): LeanDefaults | undefined => (binding as LeanBinding).leanDefaults;

/** The default `parent`'s node class has for `key`, or undefined when it has none worth writing. */
function defaultFor(defaults: LeanDefaults | undefined, parent: AbstractType<unknown>, key: string): unknown {
  if (key === '__type' || parent._item?.deleted) return undefined;
  const type = parent._map.get('__type');
  if (!type || type.deleted) return undefined;
  const values = defaults?.get(type.content.getContent()[0] as string);
  return values && Object.hasOwn(values, key) ? values[key] : undefined;
}

function write(parent: AbstractType<unknown>, key: string, value: unknown): boolean {
  if (parent instanceof YMap) parent.set(key, value);
  else if (parent instanceof XmlText || parent instanceof XmlElement) parent.setAttribute(key, value as string);
  else return false;
  return true;
}

/**
 * Called on an undo's map entry before it is deleted: when it is the key's current value and its node class has a
 * lean default for it, writes that default in its place in the undo's transaction (so a redo takes it back like any
 * replaced value), and returns true. An `undefined` default reads the same either way and is not written.
 */
export function keepLeanDefault(binding: Binding, item: Item): boolean {
  const key = item.parentSub;
  const parent = item.parent as AbstractType<unknown>;
  if (key === null || item.deleted || parent._map.get(key) !== item) return false;
  const value = defaultFor(leanDefaultsOf(binding), parent, key);
  return value !== undefined && write(parent, key, value);
}

const isNodeType = (type: AbstractType<unknown>) => type instanceof YMap || type instanceof XmlText || type instanceof XmlElement;
const stored = (type: AbstractType<unknown>, key: string) => {
  const item = type._map.get(key);
  return item !== undefined && !item.deleted;
};

/**
 * For a client still on the earlier binding and undo, whose undo of a key's first write deletes the key, and whose
 * reader then assigns `undefined` to the node: after each transaction `from` accepts that left a body node's key empty,
 * the class's lean default is written back under `origin`, so every reader, earlier or lean, holds the default.
 * Returns the detach.
 */
export function keepLeanKeys(doc: Doc, defaults: LeanDefaults, origin: unknown, from: (origin: unknown) => boolean): () => void {
  const root = doc.get('root', XmlText) as AbstractType<unknown>;
  let emptied: [AbstractType<unknown>, string][] = [];
  /** In the body and not deleted, nor inside a deleted node. */
  const live = (type: AbstractType<unknown>) => {
    let at = type;
    while (at._item) {
      if (at._item.deleted) return false;
      at = at._item.parent as AbstractType<unknown>;
    }
    return at === root;
  };
  const collect = (transaction: Transaction) => {
    if (transaction.origin === origin || !from(transaction.origin)) return;
    for (const [changed, keys] of transaction.changed) {
      const type = changed as unknown as AbstractType<unknown>;
      if (!isNodeType(type)) continue;
      for (const key of keys) if (key !== null && !stored(type, key)) emptied.push([type, key]);
    }
  };
  const restore = () => {
    if (!emptied.length) return;
    const due = emptied;
    emptied = [];
    const writes: [AbstractType<unknown>, string, unknown][] = [];
    for (const [type, key] of due) {
      if (stored(type, key) || !live(type)) continue;
      const value = defaultFor(defaults, type, key);
      if (value !== undefined) writes.push([type, key, value]);
    }
    if (!writes.length) return;
    doc.transact(() => {
      for (const [type, key, value] of writes) if (!stored(type, key)) write(type, key, value);
    }, origin);
  };
  doc.on('afterTransaction', collect);
  doc.on('afterAllTransactions', restore);
  return () => {
    doc.off('afterTransaction', collect);
    doc.off('afterAllTransactions', restore);
  };
}
