// ported-from: packages/desktop/src/common/nodeUtils.ts @ 762abb777
/**
 * Utilities for working with Lexical editor nodes.
 */

import { NODE_TYPE_MAP } from './nodeTypeMap';
import type { NoteNode, NoteNodeType } from './noteTypes';

/**
 * Extract a NoteNode object from a raw Lexical node.
 */
export const extractNoteNode = (raw: Record<string, unknown>, type: NoteNodeType): NoteNode => {
  const node: NoteNode = {
    type,
    lexicalType: raw.type as string
  };

  // Extract type-specific properties
  switch (type) {
    case 'text':
      if (typeof raw.text === 'string') {
        node.text = raw.text;
        node.characterCount = raw.text.length;
      }
      break;
    case 'heading':
      if (typeof raw.tag === 'string') {
        node.level = parseInt(raw.tag.replace('h', ''), 10);
      }
      break;
    case 'code':
      if (typeof raw.language === 'string') {
        node.language = raw.language;
      }
      break;
    case 'image':
      if (typeof raw.src === 'string') node.src = raw.src;
      if (typeof raw.altText === 'string') node.alt = raw.altText;
      break;
    case 'link':
      if (typeof raw.url === 'string') {
        node.url = raw.url;
      }
      break;
    case 'fileLink':
      if (typeof raw.noteTitle === 'string') {
        node.noteTitle = raw.noteTitle;
      }
      break;
  }

  return node;
};

/**
 * Recursively collect nodes from editor state.
 */
export function collectNodes(raw: Record<string, unknown>, nodes: NoteNode[]): void {
  const lexicalType = raw.type as string | undefined;

  if (lexicalType) {
    const mappedType = NODE_TYPE_MAP[lexicalType];
    if (mappedType) {
      const node = extractNoteNode(raw, mappedType);
      nodes.push(node);
    }
  }

  const children = raw.children as Record<string, unknown>[] | undefined;
  if (Array.isArray(children)) {
    for (const child of children) {
      collectNodes(child, nodes);
    }
  }
}
