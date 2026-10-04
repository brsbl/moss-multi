// ported-from: packages/desktop/stories/utils/actionTabFixtures.ts @ 762abb777
import type { ActionTabEntry } from '@moss/shared';
import { deriveSubmittedLabel } from '@moss/shared/utils/actionTabTimestamp';

export const STORY_NOW = new Date('2026-02-13T13:37:00Z');

export const minutesAgoToIso = (minutesAgo: number): string => {
  return new Date(STORY_NOW.getTime() - minutesAgo * 60_000).toISOString();
};

export const minutesAgoToMs = (minutesAgo: number): number => {
  return STORY_NOW.getTime() - minutesAgo * 60_000;
};

function createBaseTab(
  id: string,
  status: ActionTabEntry['status'],
  minutesAgo: number,
  overrides: Partial<ActionTabEntry> = {}
): ActionTabEntry {
  const createdAt = minutesAgoToIso(minutesAgo);
  const hasTerminalStatus = status === 'completed' || status === 'error' || status === 'interrupted';

  return {
    id,
    status,
    prompt: status === 'draft' ? '' : `Action ${id}`,
    responseSummary: null,
    errorMessage: null,
    createdAt,
    completedAt: hasTerminalStatus ? createdAt : null,
    submittedLabel: deriveSubmittedLabel(status, createdAt, STORY_NOW),
    todos: [],
    changes: [],
    messages: [],
    streamingText: '',
    isStreaming: false,
    activeTools: [],
    lastToolName: null,
    streamError: null,
    toolCallCounts: {},
    syntheticAck: null,
    ...overrides
  };
}

export const createDraftTab = (): ActionTabEntry =>
  createBaseTab('draft', 'draft', 0, {
    createdAt: STORY_NOW.toISOString(),
    completedAt: null,
    submittedLabel: null
  });

export const createCompletedTab = (
  id: string,
  minutesAgo: number,
  overrides: Partial<ActionTabEntry> = {}
): ActionTabEntry => {
  return createBaseTab(id, 'completed', minutesAgo, overrides);
};

export const createPendingTab = (
  id: string,
  minutesAgo: number,
  overrides: Partial<ActionTabEntry> = {}
): ActionTabEntry => {
  const startedAt = minutesAgoToMs(Math.max(0, minutesAgo - 1));
  return createBaseTab(id, 'pending', minutesAgo, {
    completedAt: null,
    isStreaming: true,
    activeTools: [{ toolId: `${id}-tool-1`, toolName: 'Read', startedAt }],
    lastToolName: 'Read',
    toolCallCounts: { Read: 1 },
    ...overrides
  });
};

export const createInterruptedTab = (
  id: string,
  minutesAgo: number,
  overrides: Partial<ActionTabEntry> = {}
): ActionTabEntry => {
  return createBaseTab(id, 'interrupted', minutesAgo, {
    interruptReason: 'user-cancelled',
    ...overrides
  });
};

export const createErrorTab = (
  id: string,
  minutesAgo: number,
  overrides: Partial<ActionTabEntry> = {}
): ActionTabEntry => {
  const retryInputs = overrides.retryInputs === undefined && overrides.streamError?.retryable
    ? {}
    : overrides.retryInputs;

  return createBaseTab(id, 'error', minutesAgo, {
    errorMessage: 'Action failed',
    ...overrides,
    retryInputs
  });
};

export const createCompletedSequence = (count: number, startMinutesAgo = 4): ActionTabEntry[] => {
  return Array.from({ length: count }, (_, index) =>
    createCompletedTab(`action-${index + 1}`, startMinutesAgo + index * 4)
  );
};
