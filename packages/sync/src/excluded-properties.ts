// Per-viewer fields that never ride the wire (A§10.9), shared by the client binding and the DocDO's mirror. Lexical
// looks a node's exclusions up by `node.constructor`; a duplicated module or a replaced class gives the same node type
// another constructor, so the map falls back to the class's `getType()`.
import type { ExcludedProperties } from '@lexical/yjs';
import type { Klass, LexicalEditor, LexicalNode } from 'lexical';

/** By node type. `formula.__name`, `__result` and `__formulaId` are content at the pin and stay on the wire. */
export const EXCLUDED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'code-block': ['__code'],
  'html-block': ['__rawHtml'],
  formula: ['__formula'],
  chart: ['__config'],
  sketch: ['__grid', '__labels'],
  'tab-group': ['__activeIndex', '__tabWidths'],
  table: ['__colWidths'],
  'file-link': ['__resolutionState'],
};

class TypeAwareExcludedProperties extends Map<Klass<LexicalNode>, Set<string>> {
  readonly #byType = new Map<string, Set<string>>();

  override set(klass: Klass<LexicalNode>, fields: Set<string>): this {
    this.#byType.set(klass.getType(), fields);
    return super.set(klass, fields);
  }

  override get(klass: Klass<LexicalNode>): Set<string> | undefined {
    return super.get(klass) ?? this.#byType.get(klass.getType());
  }
}

/** Throws when `fields` names a node type `nodes` does not register, so a renamed moss node fails its first bind. */
export function buildExcludedProperties(
  nodes: Iterable<Klass<LexicalNode>>,
  fields: Readonly<Record<string, readonly string[]>> = EXCLUDED_FIELDS,
): ExcludedProperties {
  const byType = new Map<string, Klass<LexicalNode>>();
  for (const klass of nodes) byType.set(klass.getType(), klass);
  const excluded = new TypeAwareExcludedProperties();
  for (const [type, names] of Object.entries(fields)) {
    const klass = byType.get(type);
    if (!klass) throw new Error(`excluded properties name node type "${type}", which the editor does not register`);
    excluded.set(klass, new Set(names));
  }
  return excluded;
}

/** The exclusions for the nodes an editor registers. */
export const excludedPropertiesFor = (editor: LexicalEditor): ExcludedProperties =>
  buildExcludedProperties([...editor._nodes.values()].map((entry) => entry.klass));
