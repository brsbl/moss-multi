// ported-from: packages/shared/src/components/layout/ActionsPanelWrapper.tsx @ 762abb777
import * as React from 'react';
import { Tabs } from '@/components/primitives';
import { useAtom, useAtomValue } from 'jotai';
import { PanelRight } from 'lucide-react';
import { KeyboardShortcut } from '@/components/ui/keyboard-shortcut';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { actionsPanelActiveTabAtom } from '@/state/note-atoms';
import type { ActionsPanelTab } from '@/state/note-atoms';
import { commandPaletteDockPreviewAtom } from '@/state/atoms';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';

export interface ActionsPanelWrapperProps {
  children: React.ReactNode;
  className?: string;
  /** Whether the panel is hidden */
  hidden?: boolean;
  /** Callback to toggle panel visibility */
  onHiddenChange?: (hidden: boolean) => void;
  /** Links section rendered below both tabs without duplicating its data flow */
  linksSection?: React.ReactNode;
  /** Dynamic width (overrides w-panel-actions class) */
  width?: React.CSSProperties['width'];
  /** Resize handle element rendered at the left edge */
  resizeHandle?: React.ReactNode;
  /** Ref for the scroll container (used by children for scrollIntoView) */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Content rendered in the Properties tab */
  propertiesContent?: React.ReactNode;
  /** Whether the agent is currently streaming for this note */
  isAgentStreaming?: boolean;
}

/**
 * Wrapper for the actions panel that provides consistent layout and styling.
 * Either fully visible or fully hidden — no intermediate collapsed state.
 * Contains two tabs: Actions (default) and Properties.
 *
 * Responsive behavior:
 * - Mobile (<md): Hidden entirely
 * - Desktop (md+): dynamic width or w-panel-actions fallback
 */
export function ActionsPanelWrapper({
  children,
  className,
  hidden: isHidden = false,
  onHiddenChange,
  linksSection,
  width,
  resizeHandle,
  scrollContainerRef,
  propertiesContent,
  isAgentStreaming = false
}: ActionsPanelWrapperProps) {
  // Global tab state — sticky across note switches
  const [activeTab, setActiveTab] = useAtom(actionsPanelActiveTabAtom);
  const isCommandPaletteDockPreviewing = useAtomValue(commandPaletteDockPreviewAtom);
  // moss-multi seam: hide-registry (A§9): with Properties staged, Actions is the only tab
  const displayedTab = isCommandPaletteDockPreviewing ? 'actions' : activeTab;

  const propertiesContentRef = React.useRef<HTMLDivElement>(null);

  // Auto-switch to Actions tab when agent starts streaming,
  // unless user has an input focused inside Properties
  const prevStreamingRef = React.useRef(isAgentStreaming);
  React.useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isAgentStreaming;

    if (!isAgentStreaming || wasStreaming) return;
    // Streaming just started — switch unless user is interacting with Properties
    if (activeTab === 'properties' && propertiesContentRef.current) {
      const active = document.activeElement;
      if (active && propertiesContentRef.current.contains(active)) return;
    }
    setActiveTab('actions');
  }, [isAgentStreaming, activeTab, setActiveTab]);

  if (isHidden) {
    return null;
  }

  const triggerClass = (isActive: boolean) =>
    cn(
      'flex h-full flex-1 items-center justify-center rounded-md px-2 font-normal transition-all focus-visible:outline-none',
      isActive
        ? 'bg-surface-raised-card text-ink-default shadow-sm'
        : 'text-ink-muted hover:bg-surface-raised-control/50 hover:text-ink-default'
    );

  return (
    <aside
      data-actions-panel-wrapper="true"
      className={cn(
        'relative flex h-full shrink-0 flex-col rounded-l-xl',
        'bg-surface-notes-list',
        !width && 'w-panel-actions',
        'hidden md:flex',
        className
      )}
      style={width ? { width } : undefined}
    >
      {resizeHandle}
      <Tabs.Root
        value={displayedTab}
        onValueChange={(value) => setActiveTab(value as ActionsPanelTab)}
        className="flex h-full min-w-0 flex-1 flex-col"
      >
        {/* Row 1: Drag region + panel visibility — matches NotesListPanel Row 1 */}
        <div
          className="shrink-0 border-b border-border-subtle/30 px-panel-inset pt-panel-drag-top pb-1"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="flex h-8 items-center justify-between">
            {onHiddenChange && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onHiddenChange(true)}
                      className="flex h-7 w-7 items-center justify-center rounded text-ink-faint/80 transition-colors hover:text-ink-muted focus-visible:outline-none"
                      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                      aria-label="Hide actions panel"
                    >
                      <PanelRight className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <KeyboardShortcut keys={['⌘', '⌥', '\\']} size="compact" />
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        {/* Row 2: Tab switcher — aligned with NotesListPanel "+Note" row */}
        <div className="shrink-0 px-panel-inset pt-panel-section-gap pb-panel-section-gap">
          <Tabs.List
            aria-label="Panel tabs"
            className="flex h-7 w-full items-center rounded-lg border border-surface-glass-border bg-surface-glass p-0.5"
            style={{ fontSize: '12.5px' }}
          >
            <Tabs.Trigger value="actions" className={triggerClass(displayedTab === 'actions')}>
              Actions
              {isAgentStreaming && activeTab !== 'actions' && (
                <span className="ml-1 h-1 w-1 shrink-0 animate-pulse rounded-full bg-accent-terracotta" />
              )}
            </Tabs.Trigger>
            {/* moss-multi seam: hide-registry (A§9) */}
            {(
            <Tabs.Trigger value="properties" className={triggerClass(displayedTab === 'properties')}>
              Properties
            </Tabs.Trigger>
            )}
          </Tabs.List>
        </div>

        {/* Actions tab content — always mounted to preserve scroll & streaming state */}
        <Tabs.Content value="actions" forceMount className={cn('min-h-0 flex-1 flex-col outline-none', displayedTab === 'actions' ? 'flex' : 'hidden')}>
          <div
            ref={scrollContainerRef}
            className="sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          >
            {children}
          </div>
        </Tabs.Content>

        {/* Properties tab content */}
        {/* moss-multi seam: hide-registry (A§9) */}
        {(
        <Tabs.Content value="properties" forceMount className={cn('min-h-0 flex-1 flex-col outline-none', displayedTab === 'properties' ? 'flex' : 'hidden')}>
          <div ref={propertiesContentRef} className="sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-panel-inset pt-panel-section-gap pb-3">
            {propertiesContent}
          </div>
        </Tabs.Content>
        )}
        {linksSection}
      </Tabs.Root>
    </aside>
  );
}

export default ActionsPanelWrapper;
