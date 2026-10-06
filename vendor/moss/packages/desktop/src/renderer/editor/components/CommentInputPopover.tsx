// ported-from: packages/desktop/src/renderer/editor/components/CommentInputPopover.tsx @ 762abb777
/**
 * CommentInputPopover - Floating popover for creating new comments
 *
 * Displays a pill-shaped textarea anchored to a selection position.
 * Auto-focuses the textarea and handles submit via Cmd+Enter or button click.
 * Shift+Enter inserts a newline. Dismisses on Escape, click-outside, or successful submit.
 *
 * Uses the shared Popover primitive with a virtual anchor for positioning.
 * portal, click-outside, escape, and collision avoidance.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Popover } from '@moss/shared/primitives';
import { useAtomValue, useStore } from 'jotai';

import { CommentTextInput } from './CommentTextInput';
import { toDisplaySrc } from '../utils/asset-url';
import { lightboxSrcAtom, resolveCanvasLightboxScope } from './ImageLightbox';
import { acquireExternalEditorFocusLock } from '../../utils/external-editor-focus-lock';
import {
  commentDraftAtom,
  getDraftKey,
  commentInputStateAtom,
  DRAFT_EXPIRY_MS
} from '../plugins/CommentPlugin';
import { imagesApi } from '../../api/electron';
import { acquireCommentUiOpenFlag } from '../utils/comment-ui-open-flag';
import { resolveCanvasCollisionBoundary } from '../utils/canvas-collision-boundary';
import { MentionScope } from '@moss-multi/host/comments/mentions'; // moss-multi seam: comments (comments.md §12)

export interface CommentInputPopoverProps {
  /** Whether the popover is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Virtual anchor position for the popover */
  anchorRect: { x: number; y: number; width: number; height: number } | null;
  /** Popover placement side — 'top' for decorator nodes, 'bottom' (default) for text selections */
  anchorSide?: 'bottom' | 'top';
  /** Popover alignment — 'end' for right-aligned, 'start' (default) */
  anchorAlign?: 'start' | 'end';
  /** Callback when a comment is created */
  onCreate: (text: string, imageUrls?: string[]) => boolean;
  /** Note ID used for resolving image paths */
  noteId: string;
  /** Canvas viewport that the popover must remain inside */
  collisionBoundary?: Element | null;
}

export function CommentInputPopover({
  open,
  onOpenChange,
  anchorRect,
  anchorSide = 'bottom',
  anchorAlign = 'start',
  onCreate,
  noteId,
  collisionBoundary
}: CommentInputPopoverProps) {
  const store = useStore();
  const lightboxState = useAtomValue(lightboxSrcAtom);
  const [text, setText] = useState('');
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const focusLockReleaseRef = useRef<(() => void) | null>(null);
  const lightboxDismissGuardRef = useRef(false);
  const resolvedCollisionBoundary = useMemo(
    () => resolveCanvasCollisionBoundary(collisionBoundary, anchorRect),
    [anchorRect, collisionBoundary]
  );
  // Virtual ref for Popover positioning -- a Measurable object with getBoundingClientRect
  const virtualRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => new DOMRect()
  });

  // Update virtualRef when anchorRect changes
  if (anchorRect) {
    virtualRef.current = {
      getBoundingClientRect: () =>
        new DOMRect(anchorRect.x, anchorRect.y, anchorRect.width, anchorRect.height)
    };
  }

  const handleImageAttach = useCallback(async () => {
    const results = await imagesApi.pick.invoke({ noteId });
    if (results.length > 0) {
      setImageUrls(prev => [...prev, ...results.map(r => r.relativePath)]);
    }
  }, [noteId]);

  const handleImageRemove = useCallback((index: number) => {
    setImageUrls(prev => prev.filter((_, i) => i !== index));
  }, []);

  const acquireFocusLock = useCallback(() => {
    if (!focusLockReleaseRef.current) {
      focusLockReleaseRef.current = acquireExternalEditorFocusLock();
    }
  }, []);

  const releaseFocusLock = useCallback(() => {
    if (!focusLockReleaseRef.current) return;
    focusLockReleaseRef.current();
    focusLockReleaseRef.current = null;
  }, []);

  // Hold the external-focus lock for the entire lifetime of the popover
  useEffect(() => {
    if (!open) {
      releaseFocusLock();
      return;
    }
    acquireFocusLock();
    return () => releaseFocusLock();
  }, [open, acquireFocusLock, releaseFocusLock]);

  // Draft save/restore keyed on open state
  useEffect(() => {
    if (open) {
      // Restore draft if exists and <24h old; prune expired
      const inputState = store.get(commentInputStateAtom(noteId));
      const key = getDraftKey(inputState);
      const drafts = store.get(commentDraftAtom);
      const now = Date.now();
      const expiredKeys: string[] = [];

      for (const [k, d] of drafts) {
        if (now - d.savedAt > DRAFT_EXPIRY_MS) {
          expiredKeys.push(k);
        }
      }
      if (expiredKeys.length > 0) {
        const pruned = new Map(drafts);
        for (const k of expiredKeys) pruned.delete(k);
        store.set(commentDraftAtom, pruned);
      }

      if (key) {
        const draft = drafts.get(key);
        if (draft && now - draft.savedAt <= DRAFT_EXPIRY_MS) {
          setText(draft.text);
          if (draft.imageUrls?.length) {
            setImageUrls(draft.imageUrls);
          }
        }
      }
    } else {
      // Save draft if text is non-empty, then clear
      const inputState = store.get(commentInputStateAtom(noteId));
      const key = getDraftKey(inputState);
      if (key && (text.trim().length > 0 || imageUrls.length > 0)) {
        const drafts = new Map(store.get(commentDraftAtom));
        drafts.set(key, {
          text,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
          savedAt: Date.now()
        });
        store.set(commentDraftAtom, drafts);
      }
      setText('');
      setImageUrls([]);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- store/text reads are one-shot via store.get

  useEffect(() => {
    return () => releaseFocusLock();
  }, [releaseFocusLock]);

  const isVisible = open && !!anchorRect;

  useEffect(() => {
    if (!isVisible) return;
    return acquireCommentUiOpenFlag();
  }, [isVisible]);

  useEffect(() => {
    if (lightboxState) {
      lightboxDismissGuardRef.current = true;
      return;
    }

    if (!lightboxDismissGuardRef.current) return;
    const releaseGuard = window.setTimeout(() => {
      lightboxDismissGuardRef.current = false;
    }, 0);
    return () => window.clearTimeout(releaseGuard);
  }, [lightboxState]);

  const shouldKeepOpenForLightbox = useCallback(() => {
    return lightboxDismissGuardRef.current || lightboxState !== null;
  }, [lightboxState]);

  const handleRootOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && shouldKeepOpenForLightbox()) {
        return;
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, shouldKeepOpenForLightbox]
  );

  const clearMatchingDraft = useCallback(() => {
    const inputState = store.get(commentInputStateAtom(noteId));
    const key = getDraftKey(inputState);
    if (!key) return;
    const drafts = new Map(store.get(commentDraftAtom));
    drafts.delete(key);
    store.set(commentDraftAtom, drafts);
  }, [noteId, store]);

  const handleSubmit = (currentText?: string) => {
    const nextText = typeof currentText === 'string' ? currentText : text;
    const trimmedText = nextText.trim();
    if (!trimmedText && imageUrls.length === 0) return;
    const created = onCreate(trimmedText, imageUrls.length > 0 ? imageUrls : undefined);
    if (!created) return;

    // Clear matching draft before closing
    clearMatchingDraft();

    setImageUrls([]);
    setText('');
    onOpenChange(false);
  };

  const hasText = text.trim().length > 0;
  const displaySrcs = imageUrls.map(url => toDisplaySrc(url, noteId));
  const handleOpenImage = useCallback(
    (startIndex: number) => {
      const sources = displaySrcs.filter((src): src is string => Boolean(src));
      if (sources.length === 0) return;
      const index = Math.min(Math.max(startIndex, 0), sources.length - 1);
      lightboxDismissGuardRef.current = true;
      store.set(lightboxSrcAtom, {
        kind: 'carousel',
        sources,
        index,
        scope: resolveCanvasLightboxScope(anchorRect)
      });
    },
    [anchorRect, displaySrcs, store]
  );

  return (
    <MentionScope docId={noteId}>{/* moss-multi seam: comments: the composer's @ offers this note's people */}
    <Popover.Root open={isVisible} onOpenChange={handleRootOpenChange}>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label="Add comment"
          side={anchorSide}
          align={anchorAlign}
          sideOffset={8}
          collisionBoundary={resolvedCollisionBoundary ? [resolvedCollisionBoundary] : undefined}
          collisionPadding={16}
          className="z-50 w-comment-input-popover max-w-floating-popover-viewport rounded-xl border border-border-subtle bg-surface-floating shadow-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          onOpenAutoFocus={e => {
            // Prevent Radix default focus behavior -- MentionInput handles autoFocus
            e.preventDefault();
          }}
          onCloseAutoFocus={e => {
            // Prevent Radix from restoring focus to the trigger
            e.preventDefault();
          }}
          onPointerDownOutside={e => {
            const target = e.target as HTMLElement | null;
            if (shouldKeepOpenForLightbox() || target?.closest?.('[data-moss-media-lightbox]')) {
              e.preventDefault();
              return;
            }
            // Allow clicks inside the editor root to close the popover (default Radix behavior)
            // but prevent dismiss for clicks inside other comment UI elements
            const targetNode = e.target as Node;
            const editorRoot = document.querySelector('[data-lexical-editor]');
            if (editorRoot?.contains(targetNode)) {
              return;
            }
          }}
          onFocusOutside={e => {
            if (shouldKeepOpenForLightbox()) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={e => {
            if (shouldKeepOpenForLightbox()) {
              e.preventDefault();
            }
          }}
        >
          <div>
            <CommentTextInput
              value={text}
              onChange={setText}
              onSubmit={handleSubmit}
              submitDisabled={!hasText && imageUrls.length === 0}
              autoFocus
              externalFocusLock
              imageAttachments={{
                imageUrls,
                onAttach: handleImageAttach,
                onRemove: handleImageRemove,
                onOpen: handleOpenImage,
                displaySrcs
              }}
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    </MentionScope>
  );
}

export default CommentInputPopover;
