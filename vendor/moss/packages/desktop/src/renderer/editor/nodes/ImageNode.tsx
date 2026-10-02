// ported-from: packages/desktop/src/renderer/editor/nodes/ImageNode.tsx @ 762abb777
import React, { useCallback, useState, useRef, useEffect } from 'react';
import type { JSX } from 'react';
import {
  $applyNodeReplacement,
  $getNodeByKey,
  COMMAND_PRIORITY_EDITOR,
  DecoratorNode,
  createCommand,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import {
  getCurrentNoteIdForEditor,
  useCurrentNoteId
} from '../CurrentNoteIdContext';
import {
  BlockNodeShell,
  MediaLightbox,
  MediaNodeHeader,
  useMediaFullscreen,
  useMediaNodeActions
} from '../components/media-primitives';
import { ToolbarTextInput } from '../components/ToolbarTextInput';
import { initCommentIds, cloneCommentIds, exportCommentIds, importCommentIds } from '../utils/commentable-node';
import { toDisplaySrc, fromDisplaySrc } from '../utils/asset-url';

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

/**
 * Navigation (arrow keys, enter, backspace, delete) is handled by DecoratorBlockPlugin
 * which provides consistent behavior across all block decorator nodes.
 */
function ImageComponent({
  src,
  altText,
  obsidianRef,
  nodeKey,
  commentIds: _commentIds = []
}: {
  src: string;
  altText: string;
  obsidianRef?: string | null;
  nodeKey: NodeKey;
  commentIds?: string[];
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const noteId = useCurrentNoteId();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const { handleDelete, handleGapClick } = useMediaNodeActions(nodeKey);
  const { isFullscreen, enterFullscreen, exitFullscreen } = useMediaFullscreen();
  const [hasError, setHasError] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [isAltTextEditing, setIsAltTextEditing] = useState(false);
  const [altTextDraft, setAltTextDraft] = useState(altText);
  const imageRef = useRef<HTMLImageElement>(null);
  const altTextInputRef = useRef<HTMLInputElement>(null);
  const altTextEditorContainerRef = useRef<HTMLDivElement>(null);

  // Convert src to displayable URL
  const displaySrc = toDisplaySrc(src, noteId);
  const versionedDisplaySrc =
    imageVersion > 0
      ? `${displaySrc}${displaySrc.includes('?') ? '&' : '?'}v=${imageVersion}`
      : displaySrc;

  // Reset error state when src changes (e.g., after remote image gets localized)
  useEffect(() => {
    setHasError(false);
    setImageVersion(0);
  }, [src]);

  useEffect(() => {
    if (!isAltTextEditing) {
      setAltTextDraft(altText);
    }
  }, [altText, isAltTextEditing]);

  useEffect(() => {
    return editor.registerCommand(
      OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND,
      ({ nodeKey: targetNodeKey }) => {
        if (targetNodeKey === nodeKey) {
          setAltTextDraft(altText);
          setIsAltTextEditing(true);
        } else {
          setIsAltTextEditing(false);
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR
    );
  }, [altText, editor, nodeKey]);

  useEffect(() => {
    if (!isAltTextEditing) {
      return;
    }

    const rafId = requestAnimationFrame(() => {
      altTextInputRef.current?.focus();
      altTextInputRef.current?.select();
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isAltTextEditing]);

  const commitAltText = useCallback((nextAltText: string) => {
    const normalizedAltText = nextAltText.trim();
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node && $isImageNode(node)) {
        node.setAltText(normalizedAltText);
      }
    });
    setIsAltTextEditing(false);
  }, [editor, nodeKey]);

  const cancelAltTextEditing = useCallback(() => {
    setAltTextDraft(altText);
    setIsAltTextEditing(false);
  }, [altText]);

  useEffect(() => {
    if (!isAltTextEditing) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && altTextEditorContainerRef.current?.contains(target)) {
        return;
      }

      cancelAltTextEditing();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [cancelAltTextEditing, isAltTextEditing]);

  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, input, [data-image-alt-text-editor]')) {
        return;
      }

      if (isAltTextEditing) {
        cancelAltTextEditing();
        return;
      }

      if (e.shiftKey) {
        setSelected(!isSelected);
      } else {
        clearSelection();
        setSelected(true);
      }
    },
    [cancelAltTextEditing, clearSelection, isAltTextEditing, isSelected, setSelected]
  );

  // Render error state — still selectable and removable: a missing asset must
  // not leave an undeletable block in the note.
  if (hasError) {
    const missingLabel = (obsidianRef || src).trim();
    return (
      <div
        className="my-3 rounded-md bg-surface-panel/70 px-3 py-2 text-center text-sm text-ink-muted"
        data-block-decorator-key={nodeKey}
        onClick={handleContainerClick}
      >
        <span>{`"${missingLabel}" could not be found.`}</span>
        <span className="ml-2 inline-flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-ink-faint underline-offset-2 hover:text-ink-muted hover:underline focus-visible:outline-none"
            onClick={(e) => {
              e.stopPropagation();
              setHasError(false);
              setImageVersion((current) => current + 1);
            }}
          >
            Retry
          </button>
          <button
            type="button"
            className="text-xs text-ink-faint underline-offset-2 hover:text-ink-muted hover:underline focus-visible:outline-none"
            onClick={(e) => {
              e.stopPropagation();
              handleDelete();
            }}
          >
            Remove
          </button>
        </span>
      </div>
    );
  }

  const imageAltTooltip = altText.trim() || undefined;

  return (
    <div
      className="group/decorator relative my-6"
      data-block-decorator-key={nodeKey}
      onClick={handleContainerClick}
    >
      <div className="mx-auto w-full max-w-canvas-prose">
        <BlockNodeShell
          selected={isSelected}
          beforeLabel="Insert paragraph before image"
          afterLabel="Insert paragraph after image"
          onGapClick={handleGapClick}
          className={`ml-0 mr-auto ${isAltTextEditing ? 'min-w-72' : ''} w-fit max-w-full`}
        >
          <div className="relative overflow-hidden rounded-lg border border-border-subtle bg-surface-raised-card">
            <MediaNodeHeader
              nodeKey={nodeKey}
              onDelete={handleDelete}
              onFullscreen={enterFullscreen}
            />

            <img
              ref={imageRef}
              src={versionedDisplaySrc}
              alt={altText}
              onError={() => setHasError(true)}
              onClick={(e) => {
                e.stopPropagation();
                if (isAltTextEditing) {
                  cancelAltTextEditing();
                  return;
                }
                clearSelection();
                setSelected(true);
                enterFullscreen();
              }}
              draggable={false}
              loading="lazy"
              decoding="async"
              title={imageAltTooltip}
              className="block h-auto max-h-canvas-image max-w-full cursor-pointer object-contain"
            />

            {isAltTextEditing ? (
              <div
                ref={altTextEditorContainerRef}
                className="border-t border-border-subtle bg-surface-canvas/90 p-2"
                data-image-alt-text-editor
                onClick={(e) => e.stopPropagation()}
              >
                <div className="w-full max-w-xl">
                  <ToolbarTextInput
                    id={`image-alt-text-${nodeKey}`}
                    ref={altTextInputRef}
                    type="text"
                    value={altTextDraft}
                    aria-label="Alt text"
                    onChange={(e) => setAltTextDraft(e.target.value)}
                    onSubmit={() => commitAltText(altTextDraft)}
                    submitAriaLabel="Apply alt text"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitAltText(altTextDraft);
                        return;
                      }

                      if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelAltTextEditing();
                      }
                    }}
                    placeholder="Describe the image"
                    className="w-full"
                  />
                </div>
              </div>
            ) : null}
          </div>
        </BlockNodeShell>
      </div>

      <MediaLightbox open={isFullscreen} onClose={exitFullscreen} anchorRef={imageRef}>
        <img
          src={versionedDisplaySrc}
          alt={altText}
          className="mx-auto block max-h-[90vh] w-auto max-w-full object-contain"
          draggable={false}
        />
      </MediaLightbox>

    </div>
  );
}

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
    return (
      <ImageComponent
        src={this.__src}
        altText={this.__altText}
        obsidianRef={this.__obsidianRef}
        nodeKey={this.__key}
        commentIds={this.__commentIds}
      />
    );
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
