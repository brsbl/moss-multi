// ported-from: packages/desktop/src/renderer/editor/nodes/VideoNode.tsx @ 762abb777 (extracted)
import type { JSX } from 'react';
import { $applyNodeReplacement, type DOMConversionMap, type DOMConversionOutput, type DOMExportOutput, DecoratorNode, type EditorConfig, type LexicalEditor, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical';
import { getCurrentNoteIdForEditor } from '../CurrentNoteIdContext';
import { cloneCommentIds, exportCommentIds, importCommentIds, initCommentIds } from '../utils/commentable-node';
import { fromDisplaySrc, toDisplaySrc } from '../utils/asset-url';
import { extractYouTubeVideoId } from '../utils/video-url';
import { renderNodeView } from './node-views';

export type SerializedVideoNode = Spread<
  {
    src: string;
    altText?: string;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

function $convertVideoElement(domNode: HTMLElement): DOMConversionOutput | null {
  const src = domNode.getAttribute('data-video-src');
  const altText = domNode.getAttribute('data-video-alt') ?? '';
  if (src) {
    return { node: $createVideoNode(fromDisplaySrc(src), altText) };
  }
  return null;
}

export class VideoNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __altText: string;
  __commentIds: string[];

  static getType(): string {
    return 'video';
  }

  static clone(node: VideoNode): VideoNode {
    return new VideoNode(node.__src, node.__altText, node.__key, cloneCommentIds(node.__commentIds));
  }

  constructor(src: string, altText = '', key?: NodeKey, commentIds?: string[]) {
    super(key);
    this.__src = src;
    this.__altText = altText;
    this.__commentIds = initCommentIds(commentIds);
  }

  static importJSON(serializedNode: SerializedVideoNode): VideoNode {
    const node = $createVideoNode(serializedNode.src, serializedNode.altText ?? '');
    node.__commentIds = importCommentIds(serializedNode as unknown as Record<string, unknown>);
    return node;
  }

  exportJSON(): SerializedVideoNode {
    return {
      type: 'video',
      version: 1,
      src: this.__src,
      ...(this.__altText ? { altText: this.__altText } : {}),
      ...exportCommentIds(this.__commentIds)
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-video-src')) return null;
        return {
          conversion: $convertVideoElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(editor?: LexicalEditor): DOMExportOutput {
    const element = document.createElement('div');
    element.setAttribute(
      'data-video-src',
      toDisplaySrc(this.__src, getCurrentNoteIdForEditor(editor))
    );
    if (this.__altText) {
      element.setAttribute('data-video-alt', this.__altText);
    }
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement('div');
    const className = config.theme.video;
    if (className) {
      div.className = className;
    }
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

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getVideoKind(): 'youtube' | 'local' {
    return extractYouTubeVideoId(this.__src) !== null ? 'youtube' : 'local';
  }

  getTextContent(): string {
    const altText = this.__altText.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    return `![${altText}](${this.__src})`;
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

export function $createVideoNode(src: string, altText = ''): VideoNode {
  return $applyNodeReplacement(new VideoNode(src, altText));
}

export function $isVideoNode(node: LexicalNode | null | undefined): node is VideoNode {
  return node instanceof VideoNode;
}
