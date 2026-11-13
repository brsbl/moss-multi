// The lean layout (A§10.11) for an undo: Yjs removes a key outright when an undo takes back the write that first stored
// it, and a client on the earlier binding reads an empty key as `undefined`, not as the class default.
import type { Binding } from '@lexical/yjs';
import { Map as YMap, XmlElement, XmlText, type AbstractType, type Item } from 'yjs';

type LeanBinding = Binding & { leanDefaults?: Map<string, Readonly<Record<string, unknown>>> };

/**
 * Called on an undo's map entry before it is deleted: when it is the key's current value and its node class has a
 * lean default for it, writes that default in its place in the undo's transaction (so a redo takes it back like any
 * replaced value), and returns true. An `undefined` default reads the same either way and is not written.
 */
export function keepLeanDefault(binding: Binding, item: Item): boolean {
  const key = item.parentSub;
  const parent = item.parent as AbstractType<unknown>;
  if (key === null || item.deleted || parent._map.get(key) !== item || parent._item?.deleted) return false;
  const type = parent._map.get('__type');
  if (!type || type.deleted) return false;
  const defaults = (binding as LeanBinding).leanDefaults?.get(type.content.getContent()[0] as string);
  if (!defaults || !Object.hasOwn(defaults, key)) return false;
  const value = defaults[key];
  if (value === undefined) return false;
  if (parent instanceof YMap) parent.set(key, value);
  else if (parent instanceof XmlText || parent instanceof XmlElement) parent.setAttribute(key, value as string);
  else return false;
  return true;
}
