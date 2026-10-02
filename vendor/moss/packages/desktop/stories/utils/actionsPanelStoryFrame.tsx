// ported-from: packages/desktop/stories/utils/actionsPanelStoryFrame.tsx @ 762abb777
import { useState, type ComponentProps, type ReactNode } from 'react';
import { ActionsPanelWrapper } from '@moss/shared/components/layout/ActionsPanelWrapper';
import { ActionsPanel } from '@moss/shared/components/ui/actions-panel';

interface ActionsPanelStoryFrameProps {
  children: ReactNode;
}

/**
 * App-accurate shell used by actions/timeline stories.
 * Reuses the real shared ActionsPanelWrapper instead of ad-hoc div wrappers.
 */
export function ActionsPanelStoryFrame({ children }: ActionsPanelStoryFrameProps) {
  return (
    <div className="flex h-screen justify-end bg-surface-notes-list">
      <div className="h-full w-panel-actions">
        <ActionsPanelWrapper>
          {children}
        </ActionsPanelWrapper>
      </div>
    </div>
  );
}

type StatefulActionsPanelProps = Omit<
  ComponentProps<typeof ActionsPanel>,
  'expandedIds' | 'onExpandedIdsChange'
>;

export function StatefulActionsPanel(props: StatefulActionsPanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  return (
    <ActionsPanelStoryFrame>
      <ActionsPanel
        {...props}
        expandedIds={expandedIds}
        onExpandedIdsChange={setExpandedIds}
      />
    </ActionsPanelStoryFrame>
  );
}

/**
 * Narrow content lane matching the timeline list region in ActionsPanel.
 */
export function ActionTimelineStoryFrame({ children }: { children: ReactNode }) {
  return (
    <ActionsPanelStoryFrame>
      <div className="h-full w-full overflow-y-auto">
        <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
          {children}
        </div>
      </div>
    </ActionsPanelStoryFrame>
  );
}
