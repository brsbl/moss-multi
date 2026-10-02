// ported-from: packages/desktop/stories/ActionTimelineCard.stories.tsx @ 762abb777
import { useState } from 'react';
import type { Story } from '@ladle/react';
import { ActionTimelineCard } from '@moss/shared/components/ui/action-timeline-card';
import {
  createCompletedTab,
  createErrorTab,
  createInterruptedTab,
  createPendingTab,
  minutesAgoToMs
} from './utils/actionTabFixtures';
import { ActionTimelineStoryFrame } from './utils/actionsPanelStoryFrame';

export const meta = {
  title: 'Components/ActionTimelineCard'
};

const noop = () => {};

/** Collapsed card shows only the action label row. */
export const Collapsed: Story = () => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createCompletedTab('collapsed', 15, {
          prompt: 'Format the meeting notes with proper headings',
          messages: ['Reorganized headings and spacing for consistency.']
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Expanded completed card with user prompt, agent message, timestamp, and success row. */
export const Expanded: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createCompletedTab('expanded', 15, {
          prompt: 'Refactor the summary for better readability',
          messages: [
            'I rewrote the summary with shorter sentences, clearer section breaks, and removed duplicate ideas.'
          ]
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/**
 * Completed card with SDK token metrics. Hovering or keyboard-focusing
 * "Note updated" reveals the `Total tokens` tooltip (inputTokens + outputTokens).
 * Resting visual matches the standard Expanded story.
 */
export const ExpandedWithTokenMetrics: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createCompletedTab('expanded-with-token-metrics', 11, {
          prompt: 'Summarize this week’s research and update the dashboard',
          messages: [
            'Pulled three research notes, refreshed the dashboard summary, and linked the new report.'
          ],
          metrics: {
            sdk: {
              inputTokens: 1000,
              outputTokens: 660
            }
          }
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Expanded completed card with a rendered markdown table in the agent message. */
export const MarkdownTable: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createCompletedTab('markdown-table', 12, {
          prompt: 'Summarize the implementation status in a table',
          messages: [
            [
              'I organized the current status into a compact table:',
              '',
              '| Area | Status | Owner |',
              '| --- | --- | --- |',
              '| Parser | Complete | Moss |',
              '| Story | Verified | QA |'
            ].join('\n')
          ]
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Completed state with explicit confirmation below timestamp. */
export const CompletedWithConfirmation: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createCompletedTab('completed-with-confirmation', 6, {
          prompt: 'Update this note with the final release summary',
          messages: [
            'Done. I merged the release notes into a concise summary and cleaned up duplicate bullets.'
          ]
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Error state shows timestamp plus right-aligned red error row. */
export const ErrorState: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createErrorTab('error-action', 10, {
          prompt: 'Delete temporary cache files',
          errorMessage: 'Permission denied: Cannot access /var/cache. Administrator privileges required.'
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Interrupted state uses the same row pattern as success, but in red. */
export const InterruptedState: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createInterruptedTab('interrupted-action', 4, {
          interruptReason: 'user-cancelled',
          prompt: 'Rewrite the intro and tighten the tone',
          messages: ['I started rewriting the intro and aligned the tone with the rest of the note.']
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Interrupted by app close/reload — no partial messages, just the interrupted footer. */
export const InterruptedAppReload: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createInterruptedTab('interrupted-app-reload', 12, {
          interruptReason: 'app-reload',
          prompt: 'Reorganize the document into chapters',
          messages: []
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Interrupted by app close after partial work — shows agent messages before the interrupted footer. */
export const InterruptedAppReloadWithMessages: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createInterruptedTab('interrupted-app-reload-msgs', 8, {
          interruptReason: 'app-reload',
          prompt: 'Write a detailed analysis of the quarterly results',
          messages: [
            'I started analyzing the revenue data and drafted the first two sections covering growth trends and regional breakdowns.'
          ]
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Interrupted by trashing the note while agent was running. */
export const InterruptedTrashed: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createInterruptedTab('interrupted-trashed', 6, {
          interruptReason: 'trashed',
          prompt: 'Clean up the formatting and fix typos',
          messages: ['I corrected several typos and started reformatting the bullet lists.']
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
      />
    </ActionTimelineStoryFrame>
  );
};

/** Pending state shows rotating status text + icons and stop button on a separate line. */
export const PendingState: Story = () => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={createPendingTab('pending-action', 2, {
          prompt: 'Generate API documentation from source code',
          messages: ['I reviewed current endpoints and started organizing output sections.'],
          activeTools: [{ toolId: 'websearch-1', toolName: 'WebSearch', startedAt: minutesAgoToMs(1) }],
          lastToolName: 'WebSearch',
          toolCallCounts: { WebSearch: 1 }
        })}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
        onCancel={noop}
      />
    </ActionTimelineStoryFrame>
  );
};
