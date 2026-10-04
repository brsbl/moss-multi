// ported-from: packages/desktop/src/renderer/editor/nodes/ImageNode.tsx @ 762abb777
import React, { useCallback, useState, useRef, useEffect } from 'react';
import type { JSX } from 'react';
import { $getNodeByKey, COMMAND_PRIORITY_EDITOR, type NodeKey } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { useCurrentNoteId } from '../CurrentNoteIdContext';
import {
  BlockNodeShell,
  MediaLightbox,
  MediaNodeHeader,
  useMediaFullscreen,
  useMediaNodeActions
} from '../components/media-primitives';
import { ToolbarTextInput } from '../components/ToolbarTextInput';
import { toDisplaySrc } from '../utils/asset-url';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { $isImageNode, ImageNode, OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND } from './ImageNode';
import { registerNodeView } from './node-views';
export { $createImageNode, $isImageNode, ImageNode, OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND } from './ImageNode';
export type { SerializedImageNode } from './ImageNode';

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

// moss-multi seam: node-views (A§12)
registerNodeView(ImageNode.getType(), function decorate(this: ImageNode): JSX.Element {
    return (
      <ImageComponent
        src={this.__src}
        altText={this.__altText}
        obsidianRef={this.__obsidianRef}
        nodeKey={this.__key}
        commentIds={this.__commentIds}
      />
    );
  });
