// ported-from: packages/desktop/src/renderer/editor/nodes/ImageNode.tsx @ 762abb777 (extracted)
import type { JSX } from 'react';
import { $applyNodeReplacement, type DOMConversionMap, type DOMConversionOutput, type DOMExportOutput, DecoratorNode, type EditorConfig, type LexicalCommand, type LexicalEditor, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread, createCommand } from 'lexical';
import { getCurrentNoteIdForEditor } from '../CurrentNoteIdContext';
import { cloneCommentIds, exportCommentIds, importCommentIds, initCommentIds } from '../utils/commentable-node';
import { fromDisplaySrc, toDisplaySrc } from '../utils/asset-url';
import { renderNodeView } from './node-views';

export type SerializedImageNode = Spread<
  {
    src: string;
    altText: string;
    commentIds?: string[];
    obsidianRef?: string;
  },
  SerializedLexicalNode
>;

export const OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND: LexicalCommand<{ nodeKey: NodeKey }> =
  createCommand('OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND');

function $convertImageElement(domNode: HTMLElement): DOMConversionOutput | null {
  const rawSrc = domNode.getAttribute('src');
  const altText = domNode.getAttribute('alt') || '';

  if (rawSrc) {
    const node = $createImageNode(fromDisplaySrc(rawSrc), altText);
    return { node };
  }
  return null;
}

export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __altText: string;
  __commentIds: string[];
  /** Original Obsidian embed ref (e.g. "image.png") — preserved for round-trip fidelity. */
  __obsidianRef: string | null;

  static getType(): string {
    return 'image';
  }

  static clone(node: ImageNode): ImageNode {
    const cloned = new ImageNode(
      node.__src,
      node.__altText,
      node.__key,
      cloneCommentIds(node.__commentIds)
    );
    cloned.__obsidianRef = node.__obsidianRef;
    return cloned;
  }

  constructor(
    src: string,
    altText: string,
    key?: NodeKey,
    commentIds?: string[]
  ) {
    super(key);
    this.__src = src;
    this.__altText = altText;
    this.__commentIds = initCommentIds(commentIds);
    this.__obsidianRef = null;
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    const node = $createImageNode(
      serializedNode.src,
      serializedNode.altText
    );
    node.__commentIds = importCommentIds(serializedNode as unknown as Record<string, unknown>);
    if (serializedNode.obsidianRef) {
      node.__obsidianRef = serializedNode.obsidianRef;
    }
    return node;
  }

  exportJSON(): SerializedImageNode {
    return {
      type: 'image',
      version: 1,
      src: this.__src,
      altText: this.__altText,
      ...exportCommentIds(this.__commentIds),
      ...(this.__obsidianRef ? { obsidianRef: this.__obsidianRef } : {})
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      img: () => ({
        conversion: $convertImageElement,
        priority: 1
      })
    };
  }

  exportDOM(editor?: LexicalEditor): DOMExportOutput {
    const element = document.createElement('img');
    // Use moss-asset:// URL with noteId so cross-note paste can fetch the image
    element.setAttribute('src', toDisplaySrc(this.__src, getCurrentNoteIdForEditor(editor)));
    element.setAttribute('alt', this.__altText);
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement('div');
    const theme = config.theme;
    // overflow-hidden clips the text content node Lexical adds alongside the decorator portal
    const baseClass = theme.image ?? '';
    div.className = baseClass ? `${baseClass} overflow-hidden` : 'overflow-hidden';
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  getSrc(): string {
    return this.__src;
  }

  getAltText(): string {
    return this.__altText;
  }

  setAltText(altText: string): void {
    const writable = this.getWritable();
    writable.__altText = altText;
  }

  setSrc(src: string): void {
    const writable = this.getWritable();
    writable.__src = src;
  }

  getObsidianRef(): string | null {
    return this.__obsidianRef;
  }

  setObsidianRef(ref: string | null): void {
    const writable = this.getWritable();
    writable.__obsidianRef = ref;
  }

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getTextContent(): string {
    const obsRef = this.__obsidianRef;
    if (obsRef) return `![[${obsRef}]]`;
    return `![${this.__altText || ''}](${this.__src})`;
  }

  decorate(): JSX.Element {
    // moss-multi seam: node-views (A§12)
    return renderNodeView(this);
  }

  isInline(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return true;
  }
}

export function $createImageNode(
  src: string,
  altText: string = ''
): ImageNode {
  return $applyNodeReplacement(new ImageNode(src, altText));
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}
