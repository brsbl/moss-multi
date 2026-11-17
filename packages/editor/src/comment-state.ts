// A note's comments as moss's renderer holds them (noteCommentsMapAtom), shared by the surface (mount.tsx) and the
// session tests' stand-in so both hydrate as moss does: hydrateComments derives each color from the comment's source
// and ignores the colors stored in meta.json, legacy ones included (comment-import.ts:58-77).
import { hydrateComments } from '@moss-desktop/renderer/editor/utils/comment-import';
import type { NoteComment } from '@moss/shared/state/note-atoms';
import type { EditorContent } from './desktop/pipeline';

export type CommentsMap = Record<string, NoteComment>;

export const hydrateNoteComments = (content: Pick<EditorContent, 'commentMetadata' | 'commentColors'>): CommentsMap =>
  hydrateComments(content.commentMetadata, content.commentColors);

/** meta.json's colors changed on disk: a comment whose color the user has not changed takes `next`'s. Null when none. */
export function adoptCommentColors(current: CommentsMap, previous: Record<string, number> | undefined, next: Record<string, number> | undefined): CommentsMap | null {
  let changed = false;
  const updated = Object.fromEntries(
    Object.entries(current).map(([id, comment]) => {
      const color = next?.[id];
      if (comment.color !== previous?.[id] || comment.color === color) return [id, comment];
      changed = true;
      const recolored = { ...comment, color };
      if (color === undefined) delete recolored.color;
      return [id, recolored];
    }),
  );
  return changed ? updated : null;
}

/** The colors a save writes to meta.json: those of the comments it keeps. */
export const commentColorsOf = (comments: CommentsMap): Record<string, number> =>
  Object.fromEntries(
    Object.entries(comments)
      .filter(([, comment]) => comment.color !== undefined)
      .map(([id, comment]) => [id, comment.color as number]),
  );
