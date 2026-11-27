// ported-from: packages/desktop/src/renderer/editor/nodes/FileLinkNode.tsx @ 762abb777
import type { JSX } from 'react';
// moss-multi seam: local-view (A§10): resolution depends on the viewer's access.
import { nodeView, useNodeView } from '@moss-multi/host/collab/view-state';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical';
import { AlertCircle, FileText } from 'lucide-react';

import { stripWikiLinks } from '../../../common/utils';

import type { LinkResolutionState } from '../../../common/noteTypes';
import { InlinePill } from '../components';
import { initCommentIds, cloneCommentIds, exportCommentIds, importCommentIds } from '../utils/commentable-node';

export type SerializedFileLinkNode = Spread<
  {
    noteId: string | null;
    noteTitle: string;
    isResolved: boolean;
    headingText?: string | null;
    resolutionState?: LinkResolutionState;
    displayText?: string | null;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

export type FileLinkStatus = 'resolved' | 'unresolved' | 'loading';

function FileLinkComponent({
  noteTitle,
  headingText,
  displayText,
  resolutionState,
  nodeKey
}: {
  noteTitle: string;
  headingText: string | null;
  displayText: string | null;
  resolutionState: LinkResolutionState;
  nodeKey: NodeKey;
}): JSX.Element {
  const view = useNodeView(nodeKey);
  noteTitle = view?.noteTitle ?? noteTitle;
  resolutionState = (view?.resolutionState as LinkResolutionState | undefined) ?? resolutionState;
  // Click handling is done by FileLinkPlugin at the editor root level
  // This allows the plugin to access the editor context for navigation

  // Determine display text based on link type
  const computedDisplayText = (() => {
    if (displayText && displayText.trim().length > 0) {
      return stripWikiLinks(displayText).trim();
    }

    const cleanHeading = headingText ? stripWikiLinks(headingText) : null;
    if (cleanHeading && !noteTitle) {
      // Same-note anchor: show heading only
      return cleanHeading;
    } else if (cleanHeading && noteTitle) {
      // Cross-note anchor: show "Note > Heading"
      return `${noteTitle} > ${cleanHeading}`;
    }
    // Regular wiki link: show note title
    return noteTitle;
  })();

  // Determine if link should show error state
  const hasError = resolutionState === 'not_found' || resolutionState === 'heading_not_found';

  return (
    <InlinePill
      variant={hasError ? 'file-link-broken' : 'file-link'}
      size="compact"
      icon={hasError ? AlertCircle : FileText}
      nodeKey={nodeKey}
      nodeKeyAttribute="data-file-link-node-key"
      role="link"
      tabIndex={hasError ? -1 : 0}
    >
      {computedDisplayText}
    </InlinePill>
  );
}

function $convertFileLinkElement(domNode: HTMLElement): DOMConversionOutput | null {
  const noteId = domNode.getAttribute('data-note-id');
  const noteTitle = domNode.getAttribute('data-note-title');
  const isResolved = domNode.getAttribute('data-resolved') === 'true';

  if (noteTitle) {
    // DOM conversion preserves legacy nodes - new anchor links will be created via markdown transformer
    const displayText = domNode.getAttribute('data-display-text');
    const node = $createFileLinkNode(
      noteId || null,
      noteTitle,
      isResolved,
      null,
      'unresolved',
      displayText || null
    );
    return { node };
  }
  return null;
}

export class FileLinkNode extends DecoratorNode<JSX.Element> {
  __noteId: string | null;
  __noteTitle: string;
  __isResolved: boolean;
  __headingText: string | null;
  __resolutionState: LinkResolutionState;
  __displayText: string | null;
  __commentIds: string[];

  static getType(): string {
    return 'file-link';
  }

  static clone(node: FileLinkNode): FileLinkNode {
    return new FileLinkNode(
      node.__noteId,
      node.__noteTitle,
      node.__isResolved,
      node.__headingText,
      node.__resolutionState,
      node.__displayText,
      node.__key,
      cloneCommentIds(node.__commentIds)
    );
  }

  constructor(
    noteId: string | null,
    noteTitle: string,
    isResolved: boolean,
    headingText: string | null = null,
    resolutionState: LinkResolutionState = 'unresolved',
    displayText: string | null = null,
    key?: NodeKey,
    commentIds?: string[]
  ) {
    super(key);
    this.__noteId = noteId;
    this.__noteTitle = noteTitle;
    this.__isResolved = isResolved;
    this.__headingText = headingText;
    this.__resolutionState = resolutionState;
    this.__displayText = displayText;
    this.__commentIds = initCommentIds(commentIds);
  }

  static importJSON(serializedNode: SerializedFileLinkNode): FileLinkNode {
    return $createFileLinkNode(
      serializedNode.noteId,
      serializedNode.noteTitle,
      serializedNode.isResolved,
      serializedNode.headingText ?? null,
      serializedNode.resolutionState ?? 'unresolved',
      serializedNode.displayText ?? null,
      importCommentIds(serializedNode as unknown as Record<string, unknown>)
    );
  }

  exportJSON(): SerializedFileLinkNode {
    return {
      type: 'file-link',
      version: 1,
      noteId: this.__noteId,
      noteTitle: this.__noteTitle,
      isResolved: this.__isResolved,
      headingText: this.__headingText,
      resolutionState: this.__resolutionState,
      displayText: this.__displayText,
      ...exportCommentIds(this.__commentIds)
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-note-title') || !domNode.hasAttribute('data-file-link')) {
          return null;
        }
        return {
          conversion: $convertFileLinkElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.setAttribute('data-file-link', 'true');
    element.setAttribute('data-note-id', this.__noteId || '');
    element.setAttribute('data-note-title', this.__noteTitle);
    element.setAttribute('data-resolved', String(this.__isResolved));
    if (this.__displayText) {
      element.setAttribute('data-display-text', this.__displayText);
    }
    element.textContent = this.__displayText || this.__noteTitle;
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    const theme = config.theme;
    const className = theme.fileLink;
    if (className) {
      span.className = className;
    }
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  getNoteId(): string | null {
    // moss-multi seam: local-view (A§10): activation and preview open the note this viewer resolved.
    const view = nodeView(this.__key);
    return view?.isResolved !== undefined ? (view.noteId ?? null) : this.__noteId;
  }

  getNoteTitle(): string {
    return this.__noteTitle;
  }

  setNoteTitle(noteTitle: string): FileLinkNode {
    const writable = this.getWritable();
    writable.__noteTitle = noteTitle;
    return writable;
  }

  isResolved(): boolean {
    return nodeView(this.__key)?.isResolved ?? this.__isResolved;
  }

  setResolved(noteId: string | null, isResolved: boolean): FileLinkNode {
    const writable = this.getWritable();
    writable.__noteId = noteId;
    writable.__isResolved = isResolved;
    return writable;
  }

  getHeadingText(): string | null {
    return this.__headingText;
  }

  setHeadingText(headingText: string | null): FileLinkNode {
    const writable = this.getWritable();
    writable.__headingText = headingText;
    return writable;
  }

  getResolutionState(): LinkResolutionState {
    return this.__resolutionState;
  }

  setResolutionState(resolutionState: LinkResolutionState): FileLinkNode {
    const writable = this.getWritable();
    writable.__resolutionState = resolutionState;
    return writable;
  }

  getDisplayText(): string | null {
    return this.__displayText;
  }

  setDisplayText(displayText: string | null): FileLinkNode {
    const writable = this.getWritable();
    writable.__displayText = displayText;
    return writable;
  }

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getTextContent(): string {
    const target = `${this.__noteTitle || ''}${this.__headingText ? `#${this.__headingText}` : ''}`;
    if (this.__displayText && this.__displayText.trim().length > 0) {
      return `[[${target}|${this.__displayText}]]`;
    }
    if (this.__isResolved && this.__noteId) {
      return `[[${target}|${this.__noteId}]]`;
    }
    const heading = this.__headingText ? `#${this.__headingText}` : '';
    const title = this.__noteTitle || '';
    return `[[${title}${heading}]]`;
  }

  decorate(): JSX.Element {
    return (
      <FileLinkComponent
        noteTitle={this.__noteTitle}
        headingText={this.__headingText}
        displayText={this.__displayText}
        resolutionState={this.__resolutionState}
        nodeKey={this.__key}
      />
    );
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }
}

export function $createFileLinkNode(
  noteId: string | null,
  noteTitle: string,
  isResolved: boolean = false,
  headingText: string | null = null,
  resolutionState: LinkResolutionState = 'unresolved',
  displayText: string | null = null,
  commentIds: string[] = []
): FileLinkNode {
  return $applyNodeReplacement(
    new FileLinkNode(
      noteId,
      noteTitle,
      isResolved,
      headingText,
      resolutionState,
      displayText,
      undefined,
      commentIds
    )
  );
}

export function $isFileLinkNode(node: LexicalNode | null | undefined): node is FileLinkNode {
  return node instanceof FileLinkNode;
}
