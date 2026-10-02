// ported-from: packages/desktop/src/renderer/editor/utils/comment-author-display.ts @ 762abb777
/**
 * Shared author/source display mapping for comments.
 *
 * Single source of truth for how a comment's `source` maps to its label and
 * text color so comment row rendering never drifts.
 * One clear source indicator per row: Me / Moss / External / Unknown.
 */
import type { NoteComment } from '@moss/shared/state/note-atoms';

export type CommentSource = NonNullable<NoteComment['source']>;

export interface CommentAuthorDisplay {
  source?: CommentSource;
  label: string;
  textClass: string;
}

/** Resolves a comment's effective source while preserving legacy unknown source. */
export function getCommentSource(comment: NoteComment): NoteComment['source'] {
  return comment.source;
}

/** Maps a comment source to its display label and accessible attribution color. */
export function getCommentAuthorDisplayForSource(source: NoteComment['source']): CommentAuthorDisplay {
  if (source === 'agent') {
    return {
      source,
      label: 'Moss',
      textClass: 'text-comment-author-agent'
    };
  }
  if (source === 'external') {
    return {
      source,
      label: 'External',
      textClass: 'text-comment-author-external'
    };
  }
  if (source === 'user') {
    return {
      source,
      label: 'Me',
      textClass: 'text-comment-author-user'
    };
  }
  return {
    label: 'Unknown',
    textClass: 'text-comment-author-user'
  };
}

/** Maps a comment to its display label and accessible attribution color. */
export function getCommentAuthorDisplay(comment: NoteComment): CommentAuthorDisplay {
  return getCommentAuthorDisplayForSource(getCommentSource(comment));
}

/** Maps a persisted comment color index to a readable attribution color. */
export function getCommentAttributionTextClassForColor(color?: number, fallbackSource?: NoteComment['source']): string {
  if (color === 3) return 'text-comment-author-agent';
  if (color === 4) return 'text-comment-author-external';
  if (color === 0 || color === 1 || color === 2) return 'text-comment-author-user';
  return getCommentAuthorDisplayForSource(fallbackSource).textClass;
}
