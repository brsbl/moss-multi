// A suggestion card's rows for its ready preview.
import type { Hunk } from '@moss-multi/core/suggest/apply';
import { describePreview, type ReviewRow } from '@moss-multi/core/suggest/describe';

export function usePreviewRows(ready: { hash: string; hunks: readonly Hunk[] } | null): ReviewRow[] {
  return ready ? describePreview(ready) : [];
}
