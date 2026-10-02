// ported-from: packages/shared/src/test-utils/action-tab-factory.ts @ 762abb777
import type { ActionTabEntry } from '../state/atoms';

/**
 * Creates an ActionTabEntry with sensible defaults for tests.
 * All fields are overridable — no specialized variants needed.
 *
 * @example
 * createTestTab() // completed tab with defaults
 * createTestTab({ isStreaming: true, status: 'pending' }) // streaming tab
 * createTestTab({ status: 'error', errorMessage: 'fail' }) // error tab
 */
export const createTestTab = (overrides: Partial<ActionTabEntry> = {}): ActionTabEntry => ({
  id: 'tab-1',
  status: 'completed',
  prompt: 'Test prompt',
  responseSummary: null,
  errorMessage: null,
  createdAt: '2024-01-15T10:00:00.000Z',
  completedAt: '2024-01-15T10:01:00.000Z',
  submittedLabel: 'Just now',
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
});
