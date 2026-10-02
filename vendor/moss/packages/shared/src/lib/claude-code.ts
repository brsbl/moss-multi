// ported-from: packages/shared/src/lib/claude-code.ts @ 762abb777
export const CLAUDE_CODE_INSTALL_COMMAND =
  'curl -fsSL https://claude.ai/install.sh | bash';

export const CLAUDE_CODE_AUTH_COMMAND = 'claude auth login';

export const CLAUDE_CODE_NOT_INSTALLED_MESSAGE =
  'Claude Code is not installed. Install Claude Code, sign in, and try again.';

export const CLAUDE_CODE_AUTH_REQUIRED_MESSAGE =
  "Your Claude sign-in isn't working. Sign in to Claude Code, and try again.";
