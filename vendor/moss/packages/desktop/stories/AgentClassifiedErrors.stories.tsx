// ported-from: packages/desktop/stories/AgentClassifiedErrors.stories.tsx @ 762abb777
import { useState } from 'react';
import type { Story } from '@ladle/react';
import type { ActionTabEntry } from '@moss/shared';
import { ActionTimelineCard } from '@moss/shared/components/ui/action-timeline-card';
import {
  CLAUDE_CODE_AUTH_REQUIRED_MESSAGE,
  CLAUDE_CODE_NOT_INSTALLED_MESSAGE
} from '@moss/shared/lib/claude-code';
import { createErrorTab } from './utils/actionTabFixtures';
import { ActionTimelineStoryFrame } from './utils/actionsPanelStoryFrame';

/**
 * Fix 3 — "Classify agent failures by real cause".
 *
 * When the Moss agent fails, the real cause used to be lost: the IPC layer
 * rebuilt the user message from the failure CLASSIFICATION only (collapsing most
 * causes to a generic "Claude Code stopped unexpectedly"), and classification
 * only read the child's stderr tail — so failures Claude Code reports over
 * its STRUCTURED JSON stream (auth / rate-limit / model-access / context-length,
 * which leave stderr empty) never matched.
 *
 * Fix 3:
 *   - reads in-band error signals from the SDK's parsed JSON stream
 *     (SDKAssistantMessage.error enum tokens, SDKResultError.errors[],
 *     api_error_status) and feeds them into the SAME classifier; and
 *   - gives each per-cause classification clear, actionable copy, while
 *     preserving the AgentExecutionError's own message as the fallback when no
 *     classification matches.
 *
 * Each classified cause rides through the existing Fix 2 plumbing as an `error`
 * stream event carrying `{ code, message, retryable, severity }`, which the
 * ActionTimelineCard maps to its data-driven outcome descriptor:
 *
 *   - `retryable: true`  → the icon-led PRIMARY "Retry" button shows.
 *   - `retryable: false` → NO "Retry"; only the muted "Contact support" link.
 *   - severity is 'error' for every classified cause here (red card).
 *
 * NOTHING about the card styling or the action model changes — Fix 3 only
 * extends the message + retryable mapping. These stories render the REAL
 * ActionTimelineCard so the message + correct action (Retry only when retryable)
 * is visible per case.
 *
 * The copy + retryable flags below are kept verbatim in sync with
 * `matchRuntimeFailure()` in
 * packages/desktop/src/main/agent/claude-agent.ts and
 * `buildActionUserFacingErrorMessage()` in
 * packages/desktop/src/main/ipc-handlers.ts.
 */

export const meta = {
  title: 'Components/AgentClassifiedErrors'
};

/**
 * Builds an error tab that mirrors what `updateAgentStreamAtom` produces when a
 * classified `error` stream event arrives. Each classified cause is severity
 * 'error' (red card); `retryable` drives whether the "Retry" primary renders.
 */
const createClassifiedErrorTab = (
  id: string,
  prompt: string,
  message: string,
  options: { code: string; retryable: boolean; classification?: string }
): ActionTabEntry => {
  const { code, retryable, classification } = options;
  return createErrorTab(id, 7, {
    prompt,
    errorMessage: message,
    streamError: { code, message, classification, retryable, severity: 'error' }
  });
};

/**
 * Shared expanded-card frame. Wires a stubbed `onRetry` so the "Retry" primary
 * action renders for retryable causes (the real handler re-runs the action's
 * prompt; here it is a no-op). Non-retryable causes show NO Retry regardless.
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
 * classification: auth_required / auth_invalid (AUTH_REQUIRED / AUTH_INVALID).
 * The local Claude sign-in is missing or expired — recovered in-band from the
 * SDKAssistantMessage.error token `authentication_failed`.
 * NOT retryable (retrying can't fix sign-in) → neutral setup card · NO "Retry"
 * or support link · inline `claude auth login` command.
 */
export const AuthExpired: Story = () => (
  <ExpandedCard
    action={createClassifiedErrorTab(
      'classified-auth',
      'Summarize this note and tighten the intro',
      CLAUDE_CODE_AUTH_REQUIRED_MESSAGE,
      { code: 'AUTH_REQUIRED', classification: 'auth_required', retryable: false }
    )}
  />
);

/**
 * classification: runtime_not_found (SDK_ERROR).
 * Moss could not resolve an independent Claude Code installation. The install
 * card shows Anthropic's install command inline with a copy control.
 * NOT retryable until the user installs Claude Code; the next action rechecks.
 */
export const MissingInstallation: Story = () => (
  <ExpandedCard
    action={createClassifiedErrorTab(
      'classified-runtime-not-found',
      'Fix the typo in this note',
      CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
      { code: 'SDK_ERROR', classification: 'runtime_not_found', retryable: false }
    )}
  />
);

/**
 * classification: rate_limited (RATE_LIMITED).
 * Recovered in-band from the SDKAssistantMessage.error tokens `rate_limit` /
 * `overloaded`. RETRYABLE → red card · "Retry" + "Contact support".
 */
export const RateLimited: Story = () => (
  <ExpandedCard
    action={createClassifiedErrorTab(
      'classified-rate-limit',
      'Rewrite these meeting notes as a crisp summary',
      'Claude is rate-limited right now. Try again in a bit.',
      { code: 'RATE_LIMITED', retryable: true }
    )}
  />
);

/**
 * classification: network_failure (NETWORK).
 * Transport failure / SDKAssistantMessage.error `server_error`. RETRYABLE →
 * red card · "Retry" + "Contact support".
 */
export const NetworkFailure: Story = () => (
  <ExpandedCard
    action={createClassifiedErrorTab(
      'classified-network',
      'Add a table of contents to this note',
      'Couldn’t reach Claude. Check your connection and retry.',
      { code: 'NETWORK', retryable: true }
    )}
  />
);

/**
 * classification: context_length (SDK_ERROR).
 * The note/selection exceeds the model context window — recovered from result
 * `errors[]` text or the `max_output_tokens` token. NOT retryable (same input
 * will fail again) → red card · NO "Retry", only "Contact support". The fix
 * lives in the message text ("Try a shorter selection.").
 */
export const ContextTooLong: Story = () => (
  <ExpandedCard
    action={createClassifiedErrorTab(
      'classified-context-length',
      'Restructure this entire 80-page research dump into chapters',
      'This note is too long for the agent to process. Try a shorter selection.',
      { code: 'SDK_ERROR', retryable: false }
    )}
  />
);

/**
 * classification: model_access (SDK_ERROR).
 * The requested model (e.g. Opus) isn't available on the user's Claude plan —
 * recovered from SDKAssistantMessage.error `model_not_found` /
 * `oauth_org_not_allowed` or plan-access text. NOT retryable
 * (retrying the same model can't help) → red card · NO "Retry", only "Contact
 * support".
 *
 * Quality gives Claude Code a native Sonnet fallback. This state surfaces only
 * when the CLI cannot recover with that configured fallback.
 */
export const ModelAccess: Story = () => (
  <ExpandedCard
    action={createClassifiedErrorTab(
      'classified-model-access',
      'Use deep reasoning to refactor the argument in this essay',
      "This model isn't available on your Claude plan.",
      { code: 'SDK_ERROR', retryable: false }
    )}
  />
);

/**
 * classification: billing (SDK_ERROR).
 *
 * P2 #1 — DISTINCT from model_access. A billing problem with the account
 * (expired card, no credits, suspended billing) — recovered in-band from the
 * SDKAssistantMessage.error token `billing_error` (or billing-specific result
 * text). Previously this token was misread as model_access and surfaced "This
 * model isn't available on your Claude plan.", misdirecting a user whose actual
 * problem is billing. It now gets its own, accurate copy.
 *
 * NOT retryable (retrying can't fix billing) → red card · NO "Retry", only the
 * muted "Contact support" link. The fix lives in the message text, which points
 * the user at their plan + billing.
 */
export const Billing: Story = () => (
  <ExpandedCard
    action={createClassifiedErrorTab(
      'classified-billing',
      'Draft a launch announcement from these release notes',
      'There’s a billing issue with your Claude account. Check your plan and billing, then retry.',
      { code: 'SDK_ERROR', retryable: false }
    )}
  />
);

/**
 * Fallback: a real cause with NO specific classification. Fix 3 preserves the
 * AgentExecutionError's OWN message (instead of collapsing to a blanket generic
 * line). Here the surfaced copy is the real error text. Retryable per the
 * error's own flag → red card · "Retry" + "Contact support".
 */
export const RealMessageFallback: Story = () => (
  <ExpandedCard
    action={createClassifiedErrorTab(
      'classified-real-message-fallback',
      'Reformat the changelog into release notes',
      'The Claude runtime encountered an internal error. Please try again, or update Moss if the issue persists.',
      { code: 'SDK_ERROR', retryable: true }
    )}
  />
);
