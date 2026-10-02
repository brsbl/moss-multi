// ported-from: packages/desktop/stories/AgentPreflightAndTimeout.stories.tsx @ 762abb777
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
 * Fix 5 — two independent safety nets for the agent's "it just sits there /
 * fails with no help" failures, rendered through the SAME error card as Fix 2/3.
 *
 *   - PART A (preflight): a cheap, local check BEFORE the SDK subprocess spawns.
 *     If the Claude runtime can't be resolved, the run short-circuits up front
 *     and surfaces a Fix 3-classified error instead of letting a run start and
 *     fail confusingly. It REUSES Fix 3's exact message:
 *       · runtime missing  → 'runtime_not_found' guidance, NOT retryable
 *     This renders the neutral setup card with ordered install and sign-in commands.
 *     (Preflight never inspects credentials; the auth / "not signed in" card is
 *     driven later by the SDK runtime error path, classified `auth_required`.)
 *
 *   - PART B (inactivity timeout): if a run emits NO stream events for a
 *     sustained period it is aborted and surfaced as a clean, RETRYABLE `timeout`
 *     error → the red card with BOTH "Retry" and "Contact support".
 *
 * Nothing about the card styling or the action model changes — Fix 5 only adds
 * the preflight short-circuit and the timeout classification. These stories
 * render the REAL ActionTimelineCard so each user-facing state (message +
 * correct action) is human-reviewable.
 *
 * The copy + retryable flags below are kept verbatim in sync with:
 *   - `agent-preflight.ts` (preflight errors) and
 *   - `agent-errors.ts` `TimeoutError` / `AGENT_TIMEOUT_MESSAGE`, plus
 *   - `buildActionUserFacingErrorMessage()` in `ipc-handlers.ts`.
 */

export const meta = {
  title: 'Components/AgentPreflightAndTimeout'
};

/**
 * Builds an error tab mirroring what `updateAgentStreamAtom` produces when a
 * Fix 5 `error` stream event arrives. All three states are severity 'error' (red
 * card); `retryable` drives whether the "Retry" primary renders.
 */
const createFix5ErrorTab = (
  id: string,
  prompt: string,
  message: string,
  options: { code: string; retryable: boolean; classification?: string }
): ActionTabEntry => {
  const { code, retryable, classification } = options;
  return createErrorTab(id, 6, {
    prompt,
    errorMessage: message,
    streamError: { code, message, classification, retryable, severity: 'error' }
  });
};

/**
 * Shared expanded-card frame with a stubbed `onRetry`, so the "Retry" primary
 * renders for the retryable (timeout) case and is correctly absent for the
 * non-retryable preflight cases.
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
 * Runtime: NOT SIGNED IN.
 * classification: auth_required (AUTH_REQUIRED). Moss does not probe local
 * credentials; this state renders when Claude Code reports sign-in is required.
 * NOT retryable (retrying can't fix sign-in) → neutral setup card · NO "Retry"
 * or support link · inline `claude auth login` command.
 */
export const RuntimeNotSignedIn: Story = () => (
  <ExpandedCard
    action={createFix5ErrorTab(
      'runtime-not-signed-in',
      'Summarize this note and tighten the intro',
      CLAUDE_CODE_AUTH_REQUIRED_MESSAGE,
      { code: 'AUTH_REQUIRED', classification: 'auth_required', retryable: false }
    )}
  />
);

/**
 * PART A — preflight: RUNTIME MISSING.
 * classification: runtime_not_found (SDK_ERROR). The bundled native Claude
 * executable could not be resolved, so the run short-circuits BEFORE spawning.
 * REUSES Fix 3's runtime-not-found classification. NOT retryable → neutral setup
 * card with install and sign-in commands · NO "Retry" or support link.
 */
export const PreflightRuntimeMissing: Story = () => (
  <ExpandedCard
    action={createFix5ErrorTab(
      'preflight-runtime-missing',
      'Add a table of contents to this note',
      CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
      { code: 'SDK_ERROR', classification: 'runtime_not_found', retryable: false }
    )}
  />
);

/**
 * PART B — inactivity TIMEOUT.
 * classification: timeout (SDK_ERROR). The run emitted no stream events for a
 * sustained period and was aborted by the inactivity timer. RETRYABLE (a stalled
 * run is usually transient) → red card · "Retry" + "Contact support".
 */
export const TimedOut: Story = () => (
  <ExpandedCard
    action={createFix5ErrorTab(
      'agent-timed-out',
      'Rewrite these meeting notes as a crisp summary',
      'The agent timed out. Try again.',
      { code: 'SDK_ERROR', retryable: true }
    )}
  />
);
