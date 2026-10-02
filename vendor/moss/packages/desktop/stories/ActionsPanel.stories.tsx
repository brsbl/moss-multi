// ported-from: packages/desktop/stories/ActionsPanel.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import type { ActionTabEntry } from '@moss/shared';
import {
  createCompletedSequence,
  createCompletedTab,
  createDraftTab,
  createErrorTab,
  createInterruptedTab,
  createPendingTab,
  minutesAgoToMs
} from './utils/actionTabFixtures';
import { StatefulActionsPanel } from './utils/actionsPanelStoryFrame';

export const meta = {
  title: 'Components/ActionsPanel'
};

const noop = () => {};

/** Empty state with no timeline cards yet. */
export const Empty: Story = () => (
  <StatefulActionsPanel
    tabs={[createDraftTab()]}

  />
);

/** A few completed actions in the same ordering used by the app panel. */
export const FewActions: Story = () => (
  <StatefulActionsPanel
    tabs={[
      createDraftTab(),
      createCompletedTab('action-1', 5, {
        prompt: 'Format the meeting notes',
        messages: ['I reorganized headings, normalized spacing, and cleaned duplicate bullets.']
      }),
      createCompletedTab('action-2', 30, {
        prompt: 'Add summary section',
        messages: ['I added a concise executive summary at the top of the note.']
      })
    ]}

  />
);

/** Scroll behavior with many completed cards. */
export const ManyActions: Story = () => {
  const completed = createCompletedSequence(10, 15).map((tab, index): ActionTabEntry => ({
    ...tab,
    prompt: `Task ${index + 1}: Update documentation`,
    messages: [`Updated section ${index + 1} and aligned language with the style guide.`]
  }));

  return (
    <StatefulActionsPanel
      tabs={[createDraftTab(), ...completed]}
  
    />
  );
};

/** Real-world mix of pending/completed/error/interrupted runs. */
export const MixedStates: Story = () => (
  <StatefulActionsPanel
    tabs={[
      createDraftTab(),
      createPendingTab('pending-1', 2, {
        prompt: 'Analyzing document structure and drafting section summaries...',
        messages: ['I parsed the headings and started grouping sections by topic.'],
        activeTools: [{ toolId: 'read-1', toolName: 'Read', startedAt: minutesAgoToMs(1) }],
        lastToolName: 'Read',
        toolCallCounts: { Read: 1 }
      }),
      createCompletedTab('completed-1', 15, {
        prompt: 'Refine the release summary',
        messages: ['I tightened wording, removed repetition, and reordered highlights for readability.']
      }),
      createErrorTab('error-1', 45, {
        prompt: 'Delete temporary files',
        errorMessage: 'Permission denied: Cannot access /system/temp'
      }),
      createInterruptedTab('interrupted-1', 20, {
        prompt: 'Refine the opening paragraph',
        messages: ['I started rewriting the opening paragraph before the run was stopped.']
      })
    ]}

    onCancelAction={noop}
  />
);

/** Post-restart recovery: previously pending tabs now show as interrupted with app-reload reason. */
export const InterruptedRecovery: Story = () => (
  <StatefulActionsPanel
    tabs={[
      createDraftTab(),
      createInterruptedTab('recovered-1', 45, {
        interruptReason: 'app-reload',
        prompt: 'Write a detailed analysis of the quarterly results',
        messages: [
          'I started analyzing the revenue data and drafted the first two sections.'
        ]
      }),
      createInterruptedTab('recovered-2', 46, {
        interruptReason: 'app-reload',
        prompt: 'Reorganize the document into chapters',
        messages: []
      }),
      createCompletedTab('older-completed', 120, {
        prompt: 'Fix the heading hierarchy',
        messages: ['Reorganized headings from H1 to H3 for consistency.']
      })
    ]}

  />
);

/** Action button always visible (prompt is now in the command palette overlay). */
export const ActionButtonAlwaysVisible: Story = () => (
  <StatefulActionsPanel
    tabs={[
      createDraftTab(),
      createCompletedTab('action-1', 10, {
        prompt: 'Previous action completed',
        messages: ['Applied the requested update to the note.']
      })
    ]}

  />
);
