// Per-viewer fields that never ride the wire (A§10.9), shared by the client binding and the DocDO's mirror.
import type { ExcludedProperties } from '@lexical/yjs';
import type { Klass, LexicalEditor, LexicalNode } from 'lexical';

/** By node type. `formula.__name`, `__result` and `__formulaId` are content at the pin and stay on the wire. */
export const EXCLUDED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'tab-group': ['__activeIndex', '__tabWidths'],
  table: ['__colWidths'],
  'file-link': ['__resolutionState'],
};

export function buildExcludedProperties(
  nodes: Iterable<Klass<LexicalNode>>,
  fields: Readonly<Record<string, readonly string[]>> = EXCLUDED_FIELDS,
): ExcludedProperties {
  const byType = new Map<string, Klass<LexicalNode>>();
  for (const klass of nodes) byType.set(klass.getType(), klass);
  const excluded: ExcludedProperties = new Map();
  for (const [type, names] of Object.entries(fields)) {
    const klass = byType.get(type);
    if (klass) excluded.set(klass, new Set(names));
  }
  return excluded;
}

/** The exclusions for the nodes an editor registers. */
export const excludedPropertiesFor = (editor: LexicalEditor): ExcludedProperties =>
  buildExcludedProperties([...editor._nodes.values()].map((entry) => entry.klass));
