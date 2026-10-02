// ported-from: packages/desktop/stories/AgentResultErrorStates.stories.tsx @ 762abb777
import { useState } from 'react';
import type { Story } from '@ladle/react';
import type { ActionTabEntry } from '@moss/shared';
import { ActionTimelineCard } from '@moss/shared/components/ui/action-timeline-card';
import {
  createCompletedTab,
  createErrorTab
} from './utils/actionTabFixtures';
import { ActionTimelineStoryFrame } from './utils/actionsPanelStoryFrame';

/**
 * Fix 2 — "Surface non-success agent results" (reworked actions).
 *
 * The Claude Agent SDK ends a run with a terminal `result` message whose
 * `subtype` is one of:
 *   - success
 *   - error_during_execution
 *   - error_max_turns
 *   - error_max_budget_usd
 *   - error_max_structured_output_retries
 *
 * Previously Moss only handled `subtype === 'success'` (with a non-empty
 * result) and silently fell through every other case, emitting a normal
 * empty `complete`. The user saw the agent "finish" having done nothing.
 *
 * Fix 2 turns each RETRYABLE non-success subtype into a structured `error`
 * stream event whose user-facing message + `retryable` + `severity` flags ride
 * through IPC onto the action tab's `streamError`. The ActionTimelineCard reads
 * those flags to choose its outcome card and a DATA-DRIVEN action descriptor:
 *
 *   - The four runtime errors (severity 'error') render the RED card with a
 *     PRIMARY "Retry" button + a SECONDARY "Contact support" link.
 *   - `empty_success` is NOT an error: it renders a NEUTRAL/muted card with a
 *     PRIMARY "Retry" button and NO support link, NO red styling, NO alert
 *     icon. Its copy is "The agent didn't return a response."
 *
 * "Retry" re-runs the action's original prompt via the same path
 * PromptBox submission uses (executeAgentForNote → agent.execute IPC). In these
 * stories the retry handler is a stub so the button renders faithfully.
 *
 * The error-row messages here are kept verbatim in sync with
 * `classifyResultSubtype()` in
 * packages/desktop/src/main/agent/agent-errors.ts.
 */

export const meta = {
  title: 'Components/AgentResultErrorStates'
};

/**
 * Builds an error tab that mirrors what `updateAgentStreamAtom` produces when an
 * `error` stream event arrives: `status: 'error'`, `errorMessage` set, and
 * `streamError = { code, message, retryable, severity }`. The four runtime
 * errors are severity 'error' (red card); `empty_success` is severity 'neutral'
 * (muted card).
 */
const createResultErrorTab = (
  id: string,
  prompt: string,
  message: string,
  options: { code?: string; severity?: 'error' | 'neutral'; retryable?: boolean } = {}
): ActionTabEntry => {
  const { code = 'SDK_ERROR', severity = 'error', retryable = true } = options;
  return createErrorTab(id, 7, {
    prompt,
    errorMessage: message,
    streamError: { code, message, retryable, severity }
  });
};

/**
 * Shared expanded-card frame. Wires a stubbed `onRetry` so the "Retry"
 * primary action renders for retryable outcomes (the real handler re-runs the
 * action's prompt; here it is a no-op).
 */
function ExpandedCard({ action }: { action: ActionTabEntry }) {
  const [isExpanded, setIsExpanded] = useState(true);
  return (
    <ActionTimelineStoryFrame>
      <ActionTimelineCard
        action={action}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
        onRetry={() => {
          /* no-op retry stub for the story */
        }}
      />
    </ActionTimelineStoryFrame>
  );
}

/**
 * subtype: error_max_turns
 * The agent ran out of allotted reasoning/tool steps before finishing.
 * Red card · "Retry" + "Contact support".
 * Message verbatim from classifyResultSubtype('error_max_turns').
 */
export const ErrorMaxTurns: Story = () => (
  <ExpandedCard
    action={createResultErrorTab(
      'result-error-max-turns',
      'Reorganize this 40-page research note into chapters with a table of contents',
      'The agent hit its step limit before finishing.'
    )}
  />
);

/**
 * subtype: error_max_budget_usd
 * The agent reached its spend ceiling before finishing.
 * Red card · "Retry" + "Contact support".
 * Message verbatim from classifyResultSubtype('error_max_budget_usd').
 */
export const ErrorMaxBudget: Story = () => (
  <ExpandedCard
    action={createResultErrorTab(
      'result-error-max-budget',
      'Research the latest framework benchmarks and write a detailed comparison',
      'The agent reached its budget limit.'
    )}
  />
);

/**
 * subtype: error_max_structured_output_retries
 * The agent could not produce a valid structured result after several retries.
 * Red card · "Retry" + "Contact support".
 * Message verbatim from classifyResultSubtype('error_max_structured_output_retries').
 */
export const ErrorMaxStructuredOutputRetries: Story = () => (
  <ExpandedCard
    action={createResultErrorTab(
      'result-error-structured-retries',
      'Extract every action item into a strict JSON checklist',
      'The agent stopped before completing.'
    )}
  />
);

/**
 * subtype: error_during_execution
 * The SDK reported a generic non-success termination.
 * Red card · "Retry" + "Contact support".
 * Message verbatim from classifyResultSubtype('error_during_execution').
 */
export const ErrorDuringExecution: Story = () => (
  <ExpandedCard
    action={createResultErrorTab(
      'result-error-during-execution',
      'Clean up the formatting and fix the broken links',
      'The agent stopped before completing.'
    )}
  />
);

/**
 * subtype: success but empty ("empty_success"): `subtype === 'success'` with no
 * result text and no note edits. NOT an error — surfaced as a NEUTRAL/muted card
 * with a PRIMARY "Retry" button and NO support link, NO red styling, NO
 * alert icon.
 * Message verbatim from classifyResultSubtype('empty_success').
 */
export const EmptySuccess: Story = () => (
  <ExpandedCard
    action={createResultErrorTab(
      'result-empty-success',
      'Tidy up this note',
      "The agent didn't return a response.",
      { code: 'EMPTY_RESULT', severity: 'neutral', retryable: true }
    )}
  />
);

/**
 * Control: a genuine success with result text and a note edit. This is the
 * normal `complete` path and must NOT show an outcome card — included so a
 * reviewer can compare the failure states against a healthy completion.
 */
export const SuccessControl: Story = () => (
  <ExpandedCard
    action={createCompletedTab('result-success-control', 7, {
      prompt: 'Tidy up this note',
      messages: [
        'Tightened the headings, removed three duplicate bullets, and fixed the inconsistent date formats.'
      ]
    })}
  />
);
