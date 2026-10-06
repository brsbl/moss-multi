// The suggestion review REST API (docs/design/suggestions.md §4, §8).
import type { DocsEnv } from './docs.ts';

/** The bell's rows for a new live suggestion. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function notifySuggestion(_env: DocsEnv, _notice: { docId: string; author: string; record: string }): Promise<void> {}
