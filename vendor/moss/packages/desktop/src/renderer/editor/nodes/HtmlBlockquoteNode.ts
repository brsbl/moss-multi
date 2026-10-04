// ported-from: packages/desktop/src/renderer/editor/nodes/HtmlBlockquoteNode.tsx @ 762abb777 (extracted)
// moss-multi seam: register payloads (A§10.10).
import { readRegister, writeRegister } from '@moss-multi/host/collab/registers';
import type { JSX } from 'react';
import { $applyNodeReplacement, type DOMConversionMap, type DOMConversionOutput, type DOMExportOutput, DecoratorNode, type EditorConfig, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical';
import { cloneCommentIds, exportCommentIds, importCommentIds, initCommentIds } from '../utils/commentable-node';
import { hasExplicitMossHtmlIntrinsicSize, resolveMossHtmlIntrinsicSize } from '../../../common/moss-html-dimensions';
import { renderNodeView } from './node-views';

export type HtmlBlockSource = 'blockquote' | 'fenced';

export type SerializedHtmlBlockquoteNode = Spread<
  {
    rawHtml: string;
    source?: HtmlBlockSource;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

const BR_TAG_RE = /<br\s*\/?>/gi;

const BLOCK_END_RE = /<\/(?:p|div|li|blockquote|h[1-6])>/gi;

const normalizeExtractedText = (text: string): string =>
  text
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Convert a raw HTML blockquote string into readable plain text.
 * Used only for rendering; source markdown is preserved verbatim via getRawHtml().
 */
export const extractHtmlBlockquoteText = (rawHtml: string): string => {
  const normalizedHtml = rawHtml
    .replace(BR_TAG_RE, '\n')
    .replace(BLOCK_END_RE, '$&\n');

  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(normalizedHtml, 'text/html');
    const blockquote = doc.querySelector('blockquote') ?? doc.body;
    return normalizeExtractedText(blockquote.textContent ?? rawHtml);
  }

  return normalizeExtractedText(normalizedHtml.replace(/<[^>]*>/g, ''));
};

/** Block-level tags whose presence inside a blockquote signals complex structure. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure', 'details',
]);

/**
 * Returns true when the blockquote has rich/styled content that warrants
 * capturing as a raw-HTML decorator node rather than a plain QuoteNode.
 */
function isComplexBlockquote(el: HTMLElement): boolean {
  if (el.hasAttribute('cite') || el.hasAttribute('class') || el.hasAttribute('style')) {
    return true;
  }

  let blockChildCount = 0;
  for (let i = 0; i < el.children.length; i++) {
    if (BLOCK_TAGS.has(el.children[i].tagName.toLowerCase())) {
      blockChildCount++;
      if (blockChildCount > 1) return true;
    }
  }

  return false;
}

function $convertHtmlBlockquoteElement(domNode: HTMLElement): DOMConversionOutput | null {
  if (domNode.tagName.toLowerCase() !== 'blockquote') {
    return null;
  }

  if (!isComplexBlockquote(domNode)) {
    return null;
  }

  const node = $createHtmlBlockquoteNode(domNode.outerHTML, 'blockquote');
  return { node };
}

export class HtmlBlockquoteNode extends DecoratorNode<JSX.Element> {
  __regId = '';
  __rawHtml: string;
  __source: HtmlBlockSource;
  __commentIds: string[];

  afterCloneFrom(previous: this): void {
    super.afterCloneFrom(previous);
    this.__regId = previous.__regId;
  }

  static getType(): string {
    return 'html-block';
  }

  static clone(node: HtmlBlockquoteNode): HtmlBlockquoteNode {
    return new HtmlBlockquoteNode(
      node.__rawHtml,
      node.__source,
      node.__key,
      cloneCommentIds(node.__commentIds)
    );
  }

  constructor(
    rawHtml: string,
    source: HtmlBlockSource = 'fenced',
    key?: NodeKey,
    commentIds?: string[]
  ) {
    super(key);
    this.__rawHtml = rawHtml;
    this.__source = source;
    this.__commentIds = initCommentIds(commentIds);
  }

  static importJSON(serializedNode: SerializedHtmlBlockquoteNode): HtmlBlockquoteNode {
    const source = serializedNode.source ?? 'fenced';
    const node = $createHtmlBlockquoteNode(serializedNode.rawHtml, source);
    node.__commentIds = importCommentIds(serializedNode as unknown as Record<string, unknown>);
    return node;
  }

  exportJSON(): SerializedHtmlBlockquoteNode {
    return {
      type: 'html-block',
      version: 1,
      rawHtml: this.getRawHtml(),
      source: this.__source,
      ...exportCommentIds(this.__commentIds)
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      blockquote: (domNode: HTMLElement) => {
        if (!isComplexBlockquote(domNode)) {
          return null;
        }
        return {
          conversion: $convertHtmlBlockquoteElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('blockquote');
    element.textContent = extractHtmlBlockquoteText(this.getRawHtml());
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement('div');
    const theme = config.theme;
    const baseClass = theme.htmlBlockquote ?? theme.htmlBlock ?? '';
    // overflow-hidden clips the text content node Lexical adds alongside the decorator portal
    div.className = baseClass ? `${baseClass} overflow-hidden` : 'overflow-hidden';
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  getRawHtml(): string {
    return readRegister(this, this.__rawHtml);
  }

  setRawHtml(rawHtml: string): void {
    const writable = this.getWritable();
    writable.__rawHtml = rawHtml;
    writeRegister(writable, rawHtml);
  }

  getSource(): HtmlBlockSource {
    return this.__source;
  }

  /** Intrinsic preview width derived from the saved moss-html content. */
  getDeclaredPreviewWidth(): number {
    return resolveMossHtmlIntrinsicSize(this.getRawHtml()).width;
  }

  /** Intrinsic preview height derived from the saved moss-html content. */
  getDeclaredPreviewHeight(): number {
    return resolveMossHtmlIntrinsicSize(this.getRawHtml()).height;
  }

  hasCustomPreviewSize(): boolean {
    return hasExplicitMossHtmlIntrinsicSize(resolveMossHtmlIntrinsicSize(this.getRawHtml()));
  }

  setPreviewSize(_width: number | null | undefined, _height: number | null | undefined): void {}

  resetPreviewSize(): void {}

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getTextContent(): string {
    return extractHtmlBlockquoteText(this.getRawHtml());
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

export function $createHtmlBlockquoteNode(
  rawHtml: string,
  source: HtmlBlockSource = 'fenced'
): HtmlBlockquoteNode {
  return $applyNodeReplacement(
    new HtmlBlockquoteNode(rawHtml, source)
  );
}

export function $isHtmlBlockquoteNode(
  node: LexicalNode | null | undefined
): node is HtmlBlockquoteNode {
  return node instanceof HtmlBlockquoteNode;
}

export { normalizeExtractedText };
