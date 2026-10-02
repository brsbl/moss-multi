// ported-from: packages/shared/src/components/ui/actions-panel.tsx @ 762abb777
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  commandPaletteDockedAtom,
  commandPaletteDockHostAtom,
  commandPaletteDockPreviewAtom
} from '../../state/atoms';
import type { ActionTabEntry } from '../../state/atoms';
import { cn } from '@/lib/utils';
import { TooltipProvider } from './tooltip';
import { ActionTimelineCard } from './action-timeline-card';

interface ActionsPanelProps {
  tabs: ActionTabEntry[];
  className?: string;
  /**
   * Whether the agent has finished execution.
   * Used to auto-unfurl the last message on completion.
   */
  isAgentComplete?: boolean;
  /**
   * Set of expanded tab IDs (controlled from parent for persistence across notes).
   */
  expandedIds: Set<string>;
  /**
   * Callback to update expanded IDs.
   */
  onExpandedIdsChange: (update: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  /** Called when the user clicks Stop on a streaming action */
  onCancelAction?: () => void;
  /** Called when the user clicks the copy button on a prompt */
  onCopyPrompt?: (prompt: string) => void;
  /** Called to open uploaded prompt images in a lightbox carousel */
  onOpenImages?: (sources: string[], startIndex: number) => void;
  /** Called when the user clicks "Try again" on a retryable outcome */
  onRetry?: (action: ActionTabEntry) => void;
  /**
   * Disables every card's Retry button while the note already has an active
   * run (executeAgentForNote's busy guard would silently no-op the retry).
   */
  retryDisabled?: boolean;
  /** External scroll container ref (from ActionsPanelWrapper) */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * Actions panel with timeline-style layout.
 * Shows collapsible timeline cards for each action.
 * Non-scrolling — parent (ActionsPanelWrapper) owns the scroll container.
 */
export function ActionsPanel({
  tabs,
  className,
  isAgentComplete = false,
  expandedIds,
  onExpandedIdsChange,
  onCancelAction,
  onCopyPrompt,
  onOpenImages,
  onRetry,
  retryDisabled,
  scrollContainerRef
}: ActionsPanelProps) {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const dockHostRef = useRef<HTMLDivElement>(null);
  const isCommandPaletteDocked = useAtomValue(commandPaletteDockedAtom);
  const isCommandPaletteDockPreviewing = useAtomValue(commandPaletteDockPreviewAtom);
  const setDockHost = useSetAtom(commandPaletteDockHostAtom);
  const safeTabs = useMemo(() => Array.isArray(tabs) ? tabs : [], [tabs]);
  // Get all action tabs (no more draft filtering), sorted newest first
  const actionTabs = safeTabs
    .filter((tab) => tab.status !== 'draft') // Still filter out any legacy draft tabs
    .sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA; // Newest first
    });

  const activeStreamingTab = actionTabs.find((tab) => tab.isStreaming) ?? null;
  const isStreaming = activeStreamingTab !== null;

  // Resolve scroll container: prefer external ref, fall back to internal
  const getScrollContainer = useCallback(() => {
    return scrollContainerRef?.current ?? internalScrollRef.current;
  }, [scrollContainerRef]);

  const registerDockHost = useCallback((node: HTMLDivElement | null) => {
    dockHostRef.current = node;
    setDockHost(node);
  }, [setDockHost]);

  const syncDockedComposerOffset = useCallback(() => {
    const container = getScrollContainer();
    if (!container) return 0;
    const height = dockHostRef.current?.offsetHeight ?? 0;
    container.style.scrollPaddingTop = `${height}px`;
    return height;
  }, [getScrollContainer]);

  useEffect(() => {
    const dockHost = dockHostRef.current;
    const container = getScrollContainer();
    if (!dockHost || !container) return;

    syncDockedComposerOffset();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(syncDockedComposerOffset);
    resizeObserver?.observe(dockHost);

    return () => {
      resizeObserver?.disconnect();
      container.style.removeProperty('scroll-padding-top');
    };
  }, [getScrollContainer, syncDockedComposerOffset]);

  // Auto-scroll to the bottom of the actively streaming timeline card.
  // This avoids jumping to the very end of the full timeline list.
  useEffect(() => {
    const container = getScrollContainer();
    if (!isStreaming || !activeStreamingTab || !container) return;
    const tabElement = container.querySelector<HTMLElement>(
      `[data-action-tab-id="${activeStreamingTab.id}"]`
    );
    if (!tabElement) {
      return;
    }

    const dockedComposerHeight = syncDockedComposerOffset();
    const currentTop = container.scrollTop;
    const containerRect = container.getBoundingClientRect();
    const tabRect = tabElement.getBoundingClientRect();
    const visibleTop = currentTop + dockedComposerHeight;
    const visibleBottom = currentTop + container.clientHeight;
    const tabTop = currentTop + tabRect.top - containerRect.top;
    const tabBottom = currentTop + tabRect.bottom - containerRect.top;
    const targetTop = tabBottom > visibleBottom
      ? Math.max(0, tabBottom - container.clientHeight)
      : tabTop < visibleTop
        ? Math.max(0, tabTop - dockedComposerHeight)
        : currentTop;
    if (targetTop === currentTop) {
      return;
    }
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: targetTop, behavior: 'smooth' });
    } else {
      container.scrollTop = targetTop;
    }
  }, [
    isStreaming,
    activeStreamingTab,
    actionTabs,
    expandedIds,
    getScrollContainer,
    syncDockedComposerOffset
  ]);

  const toggleExpanded = useCallback((id: string) => {
    // If already expanded inline (e.g. streaming auto-expand), collapse it
    if (expandedIds.has(id)) {
      onExpandedIdsChange((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    // Expand this one, collapse all others (accordion)
    onExpandedIdsChange(() => new Set([id]));

    // Scroll the expanded card into view
    requestAnimationFrame(() => {
      const container = getScrollContainer();
      if (!container) return;
      const el = container.querySelector<HTMLElement>(`[data-action-tab-id="${id}"]`);
      if (!el) return;
      const containerRect = container.getBoundingClientRect();
      const elementRect = el.getBoundingClientRect();
      const elementTop = container.scrollTop + elementRect.top - containerRect.top;
      const targetTop = Math.max(0, elementTop - syncDockedComposerOffset());
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: targetTop, behavior: 'smooth' });
      } else {
        container.scrollTop = targetTop;
      }
    });
  }, [
    onExpandedIdsChange,
    expandedIds,
    getScrollContainer,
    syncDockedComposerOffset
  ]);

  return (
    <TooltipProvider>
      <div
        ref={internalScrollRef}
        data-actions-scroll
        className={cn('w-full', className)}
      >
        <div
          className={cn(
            'flex flex-col px-panel-inset pb-panel-section-gap',
            isCommandPaletteDocked || isCommandPaletteDockPreviewing
              ? 'pt-0'
              : 'pt-panel-section-gap'
          )}
          data-command-palette-docked-spacing={
            isCommandPaletteDocked || isCommandPaletteDockPreviewing ? 'compact' : 'default'
          }
        >
          <div
            data-command-palette-dock-target="true"
            className={cn(
              'sticky top-0 z-10 shrink-0 bg-surface-notes-list empty:hidden',
              isCommandPaletteDocked || isCommandPaletteDockPreviewing
                ? 'pb-0'
                : 'pb-panel-section-gap'
            )}
            ref={registerDockHost}
          />
          {/* Timeline cards */}
          <div
            className="flex flex-col gap-xs"
            data-actions-timeline-list="true"
          >
            {actionTabs.length === 0 ? (
              <p className="py-8 text-center text-caption text-ink-faint">No actions yet</p>
            ) : (
              actionTabs.map((tab, index) => (
                <div key={tab.id} data-action-tab-id={tab.id}>
                  <ActionTimelineCard
                    action={tab}
                    isExpanded={expandedIds.has(tab.id)}
                    onToggle={() => toggleExpanded(tab.id)}
                    isLast={index === 0}
                    isComplete={isAgentComplete}
                    onCancel={(tab.isStreaming || tab.status === 'pending') ? onCancelAction : undefined}
                    onCopyPrompt={onCopyPrompt}
                    onOpenImages={onOpenImages}
                    onRetry={onRetry}
                    retryDisabled={retryDisabled}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

    </TooltipProvider>
  );
}

export default ActionsPanel;
