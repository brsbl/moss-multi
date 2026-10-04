// A duplicate's media references (A§16): when the copy's folder gave a referenced file a new name, every node
// attribute naming `assets/<old>` (an image or video `__src`, a link `__url`) names `assets/<new>` instead.
import * as Y from 'yjs';
import { mediaFilename } from '@moss-multi/protocol/media';

const REFERENCE = /^(\.?\/?assets\/)([^/?#]+)([?#].*)?$/;

/** `assets/<file>` with `file` renamed, or null when the value names no renamed file. */
export function renamedReference(value: string, renames: Readonly<Record<string, string>>): string | null {
  const match = REFERENCE.exec(value);
  if (!match) return null;
  let name: string | null;
  try {
    name = mediaFilename(decodeURIComponent(match[2]));
  } catch {
    return null;
  }
  const next = name && Object.hasOwn(renames, name) ? renames[name] : undefined;
  return next ? `${match[1]}${next}${match[3] ?? ''}` : null;
}

/** Rewrites the doc's references to renamed media in one transaction under `origin`. */
export function renameAssetReferences(doc: Y.Doc, renames: Readonly<Record<string, string>>, origin: unknown): void {
  if (Object.keys(renames).length === 0) return;
  const visit = (type: Y.XmlText | Y.XmlElement) => {
    for (const [key, value] of Object.entries(type.getAttributes() as Record<string, unknown>)) {
      const next = typeof value === 'string' ? renamedReference(value, renames) : null;
      if (next !== null && next !== value) type.setAttribute(key, next as never);
    }
    const children = type instanceof Y.XmlText ? type.toDelta().map((op: { insert?: unknown }) => op.insert) : type.toArray();
    for (const child of children) if (child instanceof Y.XmlText || child instanceof Y.XmlElement) visit(child);
  };
  doc.transact(() => visit(doc.get('root', Y.XmlText)), origin);
}
