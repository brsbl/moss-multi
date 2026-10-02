// ported-from: packages/desktop/src/renderer/editor/plugins/useInlinePillHoverPreview.ts @ 762abb777
/**
 * Shared inline-pill hover-preview mechanics.
 *
 * Note/wiki file-link pills (`FileLinkPlugin`) and webpage embed pills
 * (`EmbedPillPlugin`) both want the same hover behavior: a delegated listener at
 * the editor root, a show/hide debounce, an intra-target movement guard so the
 * timer doesn't reset as the cursor crosses the pill's own children, a
 * preview-popover movement guard so moving into the floating card doesn't hide
 * it, and below-the-pill anchoring. This hook owns that mechanics layer; each
 * plugin keeps its feature-specific resolution/content as `onShow`/`onHide`
 * callbacks. Only the delay and the hover-target attribute differ — they are
 * config, not forked implementations.
 *
 * The hover target attribute can be narrower than the click/menu target: an
 * embed pill puts its hover key on the text/content span only (so the icon is a
 * click affordance that never triggers hover), while a file-link pill uses its
 * whole-pill key. `anchorSelector` lets the card still anchor below the whole
 * pill even when the hover trigger is a child span.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { LexicalEditor } from 'lexical';

export interface InlinePillHoverPosition {
  /** Left edge of the anchor. */
  x: number;
  /** Bottom edge of the anchor (the card is placed below this). */
  y: number;
  /** Height of the anchor element. */
  anchorHeight: number;
}

export interface InlinePillHoverShowParams {
  /** The matched hover-target element (may be a child span of the pill). */
  element: HTMLElement;
  /** The element the preview should anchor below (pill root, or the target). */
  anchorElement: HTMLElement;
  nodeKey: string;
  position: InlinePillHoverPosition;
}

export interface UseInlinePillHoverPreviewConfig {
  editor: LexicalEditor;
  /** Attribute carrying the node key on the hover target element. */
  nodeKeyAttribute: string;
  /**
   * Optional selector resolved upward from the hover target to anchor the card
   * below the whole pill (e.g. the root pill when the trigger is a text span).
   */
  anchorSelector?: string;
  /** Debounce before showing the preview (ms). */
  showDelayMs: number;
  /** Debounce before hiding the preview (ms). */
  hideDelayMs: number;
  /** Mirror hover with focus (keyboard tab-to-pill). Defaults to false. */
  enableFocus?: boolean;
  /**
   * Returns true if the related target belongs to the preview popover, so moving
   * the cursor into the floating card does not schedule a hide. Defaults to the
   * shared `.fixed.z-50` floating-card surface.
   */
  isPreviewPopover?: (relatedTarget: HTMLElement) => boolean;
  /** Show the preview for the resolved target (feature-specific content). */
  onShow: (params: InlinePillHoverShowParams) => void;
  /** Hide the preview (feature-specific teardown). */
  onHide: () => void;
}

const defaultIsPreviewPopover = (relatedTarget: HTMLElement): boolean =>
  Boolean(relatedTarget.closest('.fixed.z-50'));

export function useInlinePillHoverPreview({
  editor,
  nodeKeyAttribute,
  anchorSelector,
  showDelayMs,
  hideDelayMs,
  enableFocus = false,
  isPreviewPopover = defaultIsPreviewPopover,
  onShow,
  onHide
}: UseInlinePillHoverPreviewConfig): { clear: () => void } {
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest callbacks in refs so the delegated listeners register once
  // per editor and never re-attach on a parent re-render.
  const onShowRef = useRef(onShow);
  const onHideRef = useRef(onHide);
  const isPreviewPopoverRef = useRef(isPreviewPopover);
  onShowRef.current = onShow;
  onHideRef.current = onHide;
  isPreviewPopoverRef.current = isPreviewPopover;

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    clearShowTimer();
    clearHideTimer();
    onHideRef.current();
  }, [clearShowTimer, clearHideTimer]);

  useEffect(() => {
    const selector = `[${nodeKeyAttribute}]`;
    let activeRootElement: HTMLElement | null = null;
    let removeRootListeners: (() => void) | null = null;

    const targetFromEvent = (
      event: Event,
      { includeDescendant = false }: { includeDescendant?: boolean } = {}
    ): HTMLElement | null => {
      const eventTarget = event.target as HTMLElement | null;
      const closestTarget = eventTarget?.closest(selector) as HTMLElement | null;
      if (closestTarget || !includeDescendant) {
        return closestTarget;
      }
      if (!anchorSelector) {
        return null;
      }
      const anchorElement = eventTarget?.closest(anchorSelector) as HTMLElement | null;
      return anchorElement?.querySelector(selector) as HTMLElement | null;
    };

    const showFor = (targetEl: HTMLElement) => {
      const nodeKey = targetEl.getAttribute(nodeKeyAttribute);
      if (!nodeKey) return;
      clearHideTimer();
      clearShowTimer();
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        const anchorElement = anchorSelector
          ? ((targetEl.closest(anchorSelector) as HTMLElement | null) ?? targetEl)
          : targetEl;
        const rect = anchorElement.getBoundingClientRect();
        onShowRef.current({
          element: targetEl,
          anchorElement,
          nodeKey,
          position: { x: rect.left, y: rect.bottom, anchorHeight: rect.height }
        });
      }, showDelayMs);
    };

    const scheduleHide = () => {
      clearShowTimer();
      clearHideTimer();
      if (hideDelayMs <= 0) {
        onHideRef.current();
        return;
      }
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        onHideRef.current();
      }, hideDelayMs);
    };

    const handleMouseOver = (event: MouseEvent) => {
      const targetEl = targetFromEvent(event);
      if (!targetEl) return;
      // Ignore intra-target movement so the debounce timer doesn't reset on every
      // descendant entered (the icon/text spans inside the same pill).
      const related = event.relatedTarget as HTMLElement | null;
      if (related && targetEl.contains(related)) return;
      showFor(targetEl);
    };

    const handleMouseOut = (event: MouseEvent) => {
      const targetEl = targetFromEvent(event);
      if (!targetEl) return;
      const related = event.relatedTarget as HTMLElement | null;
      // Don't hide when moving into the preview popover.
      if (related && isPreviewPopoverRef.current(related)) return;
      // Don't hide on intra-target movement (cursor between the pill's children).
      if (related && targetEl.contains(related)) return;
      scheduleHide();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const targetEl = targetFromEvent(event, { includeDescendant: true });
      if (!targetEl) return;
      showFor(targetEl);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const targetEl = targetFromEvent(event, { includeDescendant: true });
      if (!targetEl) return;
      const related = event.relatedTarget as HTMLElement | null;
      if (related && targetEl.contains(related)) return;
      scheduleHide();
    };

    const attachRootListeners = (rootElement: HTMLElement | null) => {
      if (activeRootElement === rootElement) {
        return;
      }
      removeRootListeners?.();
      activeRootElement = rootElement;
      if (!rootElement) {
        return;
      }

      rootElement.addEventListener('mouseover', handleMouseOver);
      rootElement.addEventListener('mouseout', handleMouseOut);
      if (enableFocus) {
        rootElement.addEventListener('focusin', handleFocusIn);
        rootElement.addEventListener('focusout', handleFocusOut);
      }

      removeRootListeners = () => {
        rootElement.removeEventListener('mouseover', handleMouseOver);
        rootElement.removeEventListener('mouseout', handleMouseOut);
        if (enableFocus) {
          rootElement.removeEventListener('focusin', handleFocusIn);
          rootElement.removeEventListener('focusout', handleFocusOut);
        }
        removeRootListeners = null;
      };
    };

    attachRootListeners(editor.getRootElement());
    const unregisterRootListener = editor.registerRootListener((rootElement) => {
      attachRootListeners(rootElement);
    });

    return () => {
      unregisterRootListener();
      removeRootListeners?.();
      clearShowTimer();
      clearHideTimer();
    };
  }, [
    editor,
    nodeKeyAttribute,
    anchorSelector,
    showDelayMs,
    hideDelayMs,
    enableFocus,
    clearShowTimer,
    clearHideTimer
  ]);

  return { clear };
}

export default useInlinePillHoverPreview;
