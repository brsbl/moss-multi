// ported-from: packages/desktop/src/renderer/editor/utils/pending-scroll-target.ts @ 762abb777
import type { PendingScrollTarget } from '@moss/shared/state/atoms';

export function isPendingScrollTargetForNote(
  target: PendingScrollTarget | null,
  noteId: string
): target is PendingScrollTarget {
  return Boolean(
    target &&
    target.noteId === noteId &&
    (target.heading === null || target.heading.trim().length > 0)
  );
}

export function clearPendingScrollTargetIfMatch(
  current: PendingScrollTarget | null,
  noteId: string,
  heading: string | null
): PendingScrollTarget | null {
  if (!current) {
    return null;
  }
  if (current.noteId === noteId && current.heading === heading) {
    return null;
  }
  return current;
}
