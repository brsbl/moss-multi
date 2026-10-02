// ported-from: packages/desktop/src/renderer/utils/agent-error-message.ts @ 762abb777
import {
  CLAUDE_CODE_AUTH_REQUIRED_MESSAGE,
  CLAUDE_CODE_NOT_INSTALLED_MESSAGE
} from '@moss/shared/lib/claude-code';

const AGENT_EXECUTE_IPC_PREFIX =
  /^Error invoking remote method ['"]agent:execute['"]:\s*/i;
const AGENT_EXECUTION_ERROR_PREFIX = /^AgentExecutionError:\s*/i;
const FALLBACK_AGENT_ERROR_MESSAGE = 'Unable to run Moss on this note.';
const LEGACY_CLAUDE_CODE_NOT_INSTALLED_MESSAGE =
  'Claude Code is not installed. Install Claude Code, then restart Moss and try again.';
const PREVIOUS_CLAUDE_CODE_NOT_INSTALLED_MESSAGE =
  'Claude Code is not installed. Install Claude Code, and try again.';
const LEGACY_CLAUDE_CODE_AUTH_REQUIRED_MESSAGE =
  "Your Claude sign-in isn't working. Run `claude` in Terminal to sign in, then retry.";

export function normalizeAgentErrorMessageText(message: string): string {
  const normalized = message
    .replace(AGENT_EXECUTE_IPC_PREFIX, '')
    .replace(AGENT_EXECUTION_ERROR_PREFIX, '')
    .trim();

  if (
    normalized === LEGACY_CLAUDE_CODE_NOT_INSTALLED_MESSAGE ||
    normalized === PREVIOUS_CLAUDE_CODE_NOT_INSTALLED_MESSAGE
  ) {
    return CLAUDE_CODE_NOT_INSTALLED_MESSAGE;
  }
  if (normalized === LEGACY_CLAUDE_CODE_AUTH_REQUIRED_MESSAGE) {
    return CLAUDE_CODE_AUTH_REQUIRED_MESSAGE;
  }
  return normalized;
}

export function normalizeAgentExecuteErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return FALLBACK_AGENT_ERROR_MESSAGE;
  }

  const normalized = normalizeAgentErrorMessageText(error.message);

  return normalized || FALLBACK_AGENT_ERROR_MESSAGE;
}

/**
 * Electron rejects invoke() with only the error message, so an immediate
 * preflight failure can reach the renderer before its structured stream event.
 * Recover only exact stable setup classifications needed for that race.
 */
export function classifyNormalizedAgentExecuteErrorMessage(
  message: string
): 'runtime_not_found' | 'auth_required' | undefined {
  if (message === CLAUDE_CODE_NOT_INSTALLED_MESSAGE) return 'runtime_not_found';
  if (message === CLAUDE_CODE_AUTH_REQUIRED_MESSAGE) return 'auth_required';
  return undefined;
}
