// ported-from: packages/desktop/src/renderer/editor/nodes/WebEmbedNode.tsx @ 762abb777 (extracted)
import type { JSX } from 'react';
import { $applyNodeReplacement, type DOMConversionMap, type DOMConversionOutput, type DOMExportOutput, DecoratorNode, type EditorConfig, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical';
import { cloneCommentIds, exportCommentIds, importCommentIds, initCommentIds } from '../utils/commentable-node';
import { isSafeWebBrowserUrl } from '../../../common/web-embed-url';
import { renderNodeView } from './node-views';

export type SerializedWebEmbedNode = Spread<
  {
    url: string;
    altText?: string;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

function $convertWebEmbedElement(domNode: HTMLElement): DOMConversionOutput | null {
  const url = domNode.getAttribute('data-web-embed-url');
  const altText = domNode.getAttribute('data-web-embed-alt') ?? '';
  if (url && isSafeWebBrowserUrl(url)) {
    return { node: $createWebEmbedNode(url, altText) };
  }
  return null;
}

export class WebEmbedNode extends DecoratorNode<JSX.Element> {
  __url: string;
  __altText: string;
  __commentIds: string[];

  static getType(): string {
    return 'web-embed';
  }

  static clone(node: WebEmbedNode): WebEmbedNode {
    return new WebEmbedNode(
      node.__url,
      node.__altText,
      node.__key,
      cloneCommentIds(node.__commentIds)
    );
  }

  constructor(url: string, altText = '', key?: NodeKey, commentIds?: string[]) {
    super(key);
    this.__url = url;
    this.__altText = altText;
    this.__commentIds = initCommentIds(commentIds);
  }

  static importJSON(serializedNode: SerializedWebEmbedNode): WebEmbedNode {
    const url = isSafeWebBrowserUrl(serializedNode.url) ? serializedNode.url : '';
    const node = $createWebEmbedNode(url, serializedNode.altText ?? '');
    node.__commentIds = importCommentIds(serializedNode as unknown as Record<string, unknown>);
    return node;
  }

  exportJSON(): SerializedWebEmbedNode {
    return {
      type: 'web-embed',
      version: 1,
      url: this.__url,
      ...(this.__altText ? { altText: this.__altText } : {}),
      ...exportCommentIds(this.__commentIds)
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-web-embed-url')) return null;
        return {
          conversion: $convertWebEmbedElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div');
    element.setAttribute('data-web-embed-url', this.__url);
    if (this.__altText) {
      element.setAttribute('data-web-embed-alt', this.__altText);
    }
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement('div');
    const className = config.theme.webEmbed;
    if (className) {
      div.className = className;
    }
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  getUrl(): string {
    return this.__url;
  }

  getAltText(): string {
    return this.__altText;
  }

  setAltText(altText: string): void {
    const writable = this.getWritable();
    writable.__altText = altText;
  }

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getTextContent(): string {
    const altText = this.__altText.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    return `![${altText}](${this.__url})`;
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

export function $createWebEmbedNode(url: string, altText = ''): WebEmbedNode {
  return $applyNodeReplacement(new WebEmbedNode(url, altText));
}

export function $isWebEmbedNode(node: LexicalNode | null | undefined): node is WebEmbedNode {
  return node instanceof WebEmbedNode;
}
