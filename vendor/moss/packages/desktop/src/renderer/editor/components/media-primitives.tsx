// ported-from: packages/desktop/src/renderer/editor/components/media-primitives.tsx @ 762abb777
import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, JSX, ReactNode, RefObject } from 'react';
import { Maximize2, StickyNote, Trash2, X, type LucideIcon } from 'lucide-react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  type NodeKey
} from 'lexical';
import { OPEN_BLOCK_COMMENT_COMMAND } from '../plugins/CommentPlugin';
import { insertParagraphAdjacentToBlock } from '../utils/block-node-insertion';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';
export {
  GapCursor,
  BlockNodeShell,
  BLOCK_HEADER_CLASSNAME,
  BLOCK_SURFACE_CLASSNAME
} from './block-node-primitives';

export const MEDIA_EXPANDED_MAX_WIDTH_PX = 1088;

/** Tailwind color classes for comment indicators — shared by CommentGutter and
 *  MediaNodeHeader. Indexed by `comment.color` (0 = user, 3 = agent, 4 =
 *  external). Slots 1 and 2 are unused but kept as yellow fillers to preserve
 *  the index scheme for stored comments. */
export const COMMENT_COLORS = [
  'fill-highlight-chalk-yellow-light text-highlight-chalk-yellow/70',
  'fill-highlight-chalk-yellow-light text-highlight-chalk-yellow/70',
  'fill-highlight-chalk-yellow-light text-highlight-chalk-yellow/70',
  'fill-highlight-chalk-green-light text-highlight-chalk-green',
  'fill-highlight-chalk-grey-light text-highlight-chalk-grey/70',
] as const;

export const MEDIA_CHROME_BUTTON_CLASSNAME =
  'flex h-6 w-6 items-center justify-center rounded border border-border-subtle bg-surface-floating text-ink-muted shadow-sm transition-colors hover:bg-surface-panel hover:text-ink-default';

/**
 * Subscribe to the editor's `editable` flag. Block decorator nodes render in
 * both editable and read-only editors (agent / comment / preview panes), so a
 * read-only render must hide and no-op its mutating controls. Lexical applies
 * `editor.update()` regardless of the flag, so controls can't rely on being
 * unmounted — they re-read this on every change via `registerEditableListener`.
 */
export function useIsEditorEditable(): boolean {
  const [editor] = useLexicalComposerContext();
  const [editable, setEditable] = useState(() => editor.isEditable());
  useEffect(() => {
    setEditable(editor.isEditable());
    return editor.registerEditableListener((next) => setEditable(next));
  }, [editor]);
  return editable;
}

/**
 * True once `ref`'s element is at/near the viewport, latching on (never back
 * off, so a resolved preview never disappears on scroll-away). Used to gate
 * preview `ensure` work so opening a note full of embeds does not start preview
 * fetches for every mounted-but-off-screen card. When IntersectionObserver is
 * unavailable (jsdom / old runtimes) it reports `true` immediately so visible
 * behavior — and tests — preview eagerly.
 */
export function useIsNearViewport(
  ref: RefObject<Element | null>,
  rootMargin = '600px'
): boolean {
  const [isNear, setIsNear] = useState(false);

  useEffect(() => {
    if (isNear) {
      return undefined;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setIsNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsNear(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, isNear]);

  return isNear;
}

export function useMediaFullscreen(): {
  isFullscreen: boolean;
  enterFullscreen: () => void;
  exitFullscreen: () => void;
} {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const enterFullscreen = useCallback(() => {
    setIsFullscreen(true);
  }, []);

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  // DOM-level Escape handler: the lightbox is portaled outside the Lexical
  // subtree so a Lexical KEY_ESCAPE_COMMAND won't see the event.
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        exitFullscreen();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, exitFullscreen]);

  return { isFullscreen, enterFullscreen, exitFullscreen };
}

// ---------------------------------------------------------------------------
// MediaHeaderButton — small action button used in MediaNodeHeader
// ---------------------------------------------------------------------------

type MediaHeaderButtonProps = {
  icon: LucideIcon;
  title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Tailwind hover text color class. Defaults to 'hover:text-ink-default'. */
  hoverColor?: string;
  className?: string;
};

export function MediaHeaderButton({
  icon: Icon,
  title,
  onClick,
  hoverColor = 'hover:text-ink-default',
  className,
}: MediaHeaderButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={`${MEDIA_CHROME_BUTTON_CLASSNAME} ${hoverColor} ${className ?? ''}`}
      title={title}
      aria-label={title}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// MediaNodeHeader — shared header bar for block media nodes
// ---------------------------------------------------------------------------

type MediaNodeHeaderProps = {
  nodeKey: NodeKey;
  onDelete: () => void;
  onFullscreen?: () => void;
  /**
   * When false (read-only renders), the built-in mutating controls
   * (Add comment / Delete) and the fullscreen control are withheld so only the
   * caller's non-mutating children (e.g. Open in browser) remain. Defaults to
   * true to preserve existing media-node behavior. Callers gate their own
   * mutating children (e.g. Collapse) on the same flag.
   */
  editable?: boolean;
  children?: ReactNode;
};

/**
 * Shared action handlers for block-level media decorator nodes.
 * Eliminates duplicated handleDelete / handleGapClick across ImageNode, VideoNode, HtmlBlockquoteNode.
 */
export function useMediaNodeActions(nodeKey: NodeKey): {
  handleDelete: () => void;
  // moss-multi seam: read-only-media (A§19 invariant 9): no gap insert while read-only
  handleGapClick: ((position: 'before' | 'after') => (e: React.MouseEvent) => void) | undefined;
} {
  const [editor] = useLexicalComposerContext();
  const editable = useIsEditorEditable();

  const handleDelete = useCallback(() => {
    // Re-guard: Lexical applies editor.update() even when not editable, so a
    // stale callback in a read-only render must not remove the node.
    if (!editor.isEditable()) return;
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node) {
        node.remove();
      }
    });
  }, [editor, nodeKey]);

  const handleGapClick = useCallback(
    (position: 'before' | 'after') => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Re-guard: gap clicks insert a paragraph (a mutation); no-op when the
      // editor is read-only.
      if (!editor.isEditable()) return;
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!node) return;
        insertParagraphAdjacentToBlock(node, position);
      });
    },
    [editor, nodeKey]
  );

  // moss-multi seam: read-only-media (A§19 invariant 9): a read-only render offers no insert-paragraph gaps.
  return { handleDelete, handleGapClick: editable ? handleGapClick : undefined };
}

// ---------------------------------------------------------------------------
// MediaLightbox — full-window overlay for fullscreen media viewing
// ---------------------------------------------------------------------------

type MediaLightboxProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  showCloseButton?: boolean;
  constrainContent?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
};

type MediaLightboxAnchorRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const NOTE_PANE_LIGHTBOX_ANCHOR_SELECTOR = '[data-command-palette-note-pane="true"]';

const resolveLightboxAnchorElement = (
  anchorRef?: RefObject<HTMLElement | null>
): HTMLElement | null => {
  const anchorElement = anchorRef?.current ?? null;
  if (!anchorElement) {
    return document.querySelector<HTMLElement>(NOTE_PANE_LIGHTBOX_ANCHOR_SELECTOR);
  }

  return (anchorElement.closest('.canvas-scroll') as HTMLElement | null) ?? anchorElement;
};

const readLightboxAnchorRect = (
  anchorRef?: RefObject<HTMLElement | null>
): MediaLightboxAnchorRect | null => {
  const anchorElement = resolveLightboxAnchorElement(anchorRef);
  if (!anchorElement) {
    return null;
  }

  const rect = anchorElement.getBoundingClientRect();
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }

  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
};

function useMediaLightboxAnchorRect(
  open: boolean,
  anchorRef?: RefObject<HTMLElement | null>
): MediaLightboxAnchorRect | null {
  const [anchorRect, setAnchorRect] = useState<MediaLightboxAnchorRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setAnchorRect(null);
      return;
    }

    const updateAnchorRect = () => {
      setAnchorRect(readLightboxAnchorRect(anchorRef));
    };
    updateAnchorRect();
    const deferredUpdate = window.setTimeout(updateAnchorRect, 0);

    const anchorElement = resolveLightboxAnchorElement(anchorRef);
    const resizeObserver = anchorElement && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateAnchorRect)
      : null;
    if (resizeObserver && anchorElement) {
      resizeObserver.observe(anchorElement);
    }

    window.addEventListener('resize', updateAnchorRect);
    window.addEventListener('scroll', updateAnchorRect, true);
    return () => {
      window.clearTimeout(deferredUpdate);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateAnchorRect);
      window.removeEventListener('scroll', updateAnchorRect, true);
    };
  }, [anchorRef, open]);

  return anchorRect;
}

export function MediaLightbox({
  open,
  onClose,
  children,
  showCloseButton = true,
  constrainContent = true,
  anchorRef,
}: MediaLightboxProps): JSX.Element | null {
  const anchorRect = useMediaLightboxAnchorRect(open, anchorRef);

  if (!open) return null;

  const anchorRegionStyle: CSSProperties = anchorRect
    ? {
        left: `${anchorRect.left}px`,
        top: `${anchorRect.top}px`,
        width: `${anchorRect.width}px`,
        height: `${anchorRect.height}px`
      }
    : { inset: 0 };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Media preview"
      data-remote-web-surface-blocking-dialog="true"
      data-moss-media-lightbox=""
      className="app-region-no-drag fixed inset-0 z-tooltip bg-surface-modal-overlay"
      onClick={onClose}
    >
      <div
        className="absolute flex items-center justify-center p-8"
        style={anchorRegionStyle}
      >
        <div
          className={`relative flex h-fit w-fit items-center justify-center ${
            constrainContent ? 'max-h-[90vh] max-w-[90vw]' : ''
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {showCloseButton ? (
            <div className="pointer-events-auto absolute right-2 top-2 z-20">
              <MediaHeaderButton
                icon={X}
                title="Close lightbox"
                onClick={() => onClose()}
              />
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

export function MediaNodeHeader({
  nodeKey,
  onDelete,
  onFullscreen,
  editable = true,
  children,
}: MediaNodeHeaderProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  // moss-multi seam: read-only-media (A§19 invariant 9): node views never pass `editable`, so a read-only render
  // offered Delete; nothing in a read-only body takes focus.
  const editorEditable = useIsEditorEditable();
  editable = editable && editorEditable;

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-center justify-end px-2 py-1.5 opacity-0 transition-opacity group-hover/decorator:pointer-events-auto group-hover/decorator:opacity-100 group-focus-within/decorator:pointer-events-auto group-focus-within/decorator:opacity-100"
      data-media-node-header="true"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        {children}
        {/* moss-multi seam: hide-registry (A§9) */}
        {editable && !hidden('comments') && (
          <MediaHeaderButton
            icon={StickyNote}
            title="Add comment"
            onClick={() => {
              // Re-guard: opening the comment popover mutates; no-op read-only.
              if (!editor.isEditable()) return;
              editor.dispatchCommand(OPEN_BLOCK_COMMENT_COMMAND, { nodeKey });
            }}
          />
        )}
        {editable && onFullscreen && (
          <MediaHeaderButton
            icon={Maximize2}
            title="Fullscreen"
            onClick={onFullscreen}
          />
        )}
        {editable && (
          <MediaHeaderButton
            icon={Trash2}
            title="Delete"
            onClick={onDelete}
            hoverColor="hover:text-status-error-text-hover"
          />
        )}
      </div>
    </div>
  );
}
