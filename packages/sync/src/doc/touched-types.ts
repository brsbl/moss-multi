// SP7 (A§13): which root shared types a sync frame would touch, decided before it is applied.
import type * as Y from 'yjs';

export interface TouchedTypes {
  /** Root names (doc.share keys) the frame inserts into or deletes from. */
  roots: Set<string>;
  /** The frame depends on an item the doc lacks, so where it lands cannot be known yet. */
  unresolved: boolean;
}

export function touchedTypes(_doc: Y.Doc, _update: Uint8Array): TouchedTypes {
  return { roots: new Set(), unresolved: false };
}
