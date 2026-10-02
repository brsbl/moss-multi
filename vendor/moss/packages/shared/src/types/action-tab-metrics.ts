// ported-from: packages/shared/src/types/action-tab-metrics.ts @ 762abb777
export type ActionPromptSource = 'prompt' | 'comment';

/** Stage-level timestamp markers for a run (Unix epoch milliseconds). */
export interface ActionTabStageMetrics {
  submitClickedAtMs?: number;
  preflightDoneAtMs?: number;
  ipcExecuteSentAtMs?: number;
  mainExecuteStartedAtMs?: number;
  sdkQueryStartedAtMs?: number;
  firstStreamEventAtMs?: number;
  firstToolStartAtMs?: number;
  firstTextAtMs?: number;
  executionCompletedAtMs?: number;
}

/** SDK-reported usage and execution counters. */
export interface ActionTabSdkMetrics {
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  editToolCalls?: number;
}

/** Prompt and context-size diagnostics captured at dispatch time. */
export interface ActionTabContextMetrics {
  promptChars?: number;
  contentChars?: number;
  referencedNotesCount?: number;
  promptSource?: ActionPromptSource;
  mode?: 'prompt';
  nonEmptyNoteAtStart?: boolean;
}

/** Derived latency and efficiency indicators. */
export interface ActionTabDerivedMetrics {
  preflightMs?: number;
  ipcToSdkMs?: number;
  sdkToFirstEventMs?: number;
  sdkToFirstTextMs?: number;
  ttftMs?: number;
  endToEndMs?: number;
  apiShare?: number;
  cacheReuseRatio?: number;
  writeRateOnNonEmptyNote?: number;
}

export interface ActionTabMetrics {
  stage?: ActionTabStageMetrics;
  sdk?: ActionTabSdkMetrics;
  context?: ActionTabContextMetrics;
  derived?: ActionTabDerivedMetrics;
}
