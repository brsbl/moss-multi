// A note's Yjs structs per block (T3.B31b), shared by the lean layout's tests and the DocDO memory measurement. A
// block is a top-level element of the body, except that a list's blocks are its items and a table's are its rows. Each
// struct counts for the block it sits in, at any depth (a nested list counts for its outer item, a cell's paragraph for
// its row); the embed that places a block counts for the block. What sits in no block (the root's own attributes, a
// list's or table's own embed and properties, the title and frontmatter) is overhead.
import * as Y from 'yjs';

/** Containers whose children are the blocks. */
const CONTAINERS = new Set(['list', 'table']);

export interface StructsPerBlock {
  /** Every struct in the doc's store. */
  structs: number;
  blocks: number;
  /** Structs that sit in no block. */
  overhead: number;
  /** The median block's structs: the typical block, as a table's header row carries its cells' header state. */
  median: number;
  /** Block structs per block. */
  mean: number;
}

type Type = Y.AbstractType<unknown>;

const typeOf = (type: Type): unknown => (type._map.get('__type')?.content.getContent() ?? [])[0];

export function structsPerBlock(doc: Y.Doc): StructsPerBlock {
  const root = doc.get('root', Y.XmlText) as unknown as Type;
  // Each type's block (null: it sits in none), resolved once.
  const blockOf = new Map<Type, Type | null>();
  const resolve = (type: Type): Type | null => {
    const known = blockOf.get(type);
    if (known !== undefined) return known;
    let block: Type | null = null;
    const parent = type._item?.parent;
    if (parent && parent instanceof Y.AbstractType) {
      const parentType = parent as Type;
      if (parentType === root) block = CONTAINERS.has(String(typeOf(type))) ? null : type;
      else {
        const outer = resolve(parentType);
        if (outer !== null) block = outer;
        else if (parentType._item?.parent === root && CONTAINERS.has(String(typeOf(parentType)))) block = type;
      }
    }
    blockOf.set(type, block);
    return block;
  };
  const counts = new Map<Type, number>();
  let structs = 0;
  let overhead = 0;
  for (const list of doc.store.clients.values()) {
    for (const struct of list) {
      structs += 1;
      let owner: Type | null = null;
      if (struct instanceof Y.Item) {
        if (struct.content instanceof Y.ContentType) owner = struct.content.type as Type;
        else if (struct.parent instanceof Y.AbstractType) owner = struct.parent as Type;
      }
      const block = owner === null ? null : resolve(owner);
      if (block === null) overhead += 1;
      else counts.set(block, (counts.get(block) ?? 0) + 1);
    }
  }
  const sizes = [...counts.values()].sort((a, b) => a - b);
  const blocks = sizes.length;
  return {
    structs,
    blocks,
    overhead,
    median: blocks === 0 ? 0 : sizes[Math.floor((blocks - 1) / 2)]!,
    mean: blocks === 0 ? 0 : (structs - overhead) / blocks,
  };
}
