// A suggestion card's rows for its ready preview, built once per preview hash: the card's own state changes (busy,
// error, copied, expanded) never rebuild them.
import type { Hunk } from '@moss-multi/core/suggest/apply';
import { describePreview, type ReviewRow } from '@moss-multi/core/suggest/describe';
import { useMemo } from 'react';

const NONE: ReviewRow[] = [];

export function usePreviewRows(ready: { hash: string; hunks: readonly Hunk[] } | null): ReviewRow[] {
  const hash = ready?.hash ?? null;
  const hunks = ready?.hunks ?? null;
  // The hash covers the hunks, so it alone keys the rows.
  return useMemo(() => (hash !== null && hunks ? describePreview({ hash, hunks }) : NONE), [hash]);
}
