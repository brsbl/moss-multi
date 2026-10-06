// Reactions on a comment (PRODUCT: from glyphdown, not in moss desktop; docs/design/comments.md §12). Glyphdown's
// interaction, built from moss's DS: each emoji someone used shows as a chip under the message with its count, pressed
// when it includes you, and a click toggles your own; the message's actions menu offers glyphdown's five quick
// reactions. The records carry principal ids; the server adds or removes only the caller's.
import { DropdownMenuItem, DropdownMenuSeparator } from '@moss/shared/components/ui/dropdown-menu';
import type { ReactNode } from 'react';
import { react, useCanComment } from './adapter.ts';
import { myPrincipalId } from './people.ts';

/** Glyphdown's quick reactions. */
export const QUICK = ['👍', '❤️', '🎉', '👀', '😄'] as const;

const reactionsOf = (comment: unknown): [string, string[]][] => {
  const value = (comment as { reactions?: unknown } | null)?.reactions;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0);
};

/** The chips under a message; nothing when nobody has reacted. */
export function CommentReactions({ noteId, comment }: { noteId: string; comment: { id: string } }): ReactNode {
  const commentable = useCanComment(noteId);
  const entries = reactionsOf(comment);
  if (!entries.length) return null;
  const me = myPrincipalId();
  return (
    <div data-comment-reactions className="mt-1.5 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, who]) => {
        const mine = me !== null && who.includes(me);
        return (
          <button
            key={emoji}
            type="button"
            disabled={!commentable}
            aria-pressed={mine}
            aria-label={`${emoji} ${who.length}`}
            onClick={() => react(noteId, comment.id, emoji, !mine)}
            className={[
              'inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-caption leading-none tabular-nums transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-default',
              mine
                ? 'border-accent-brand/40 bg-accent-brand/10 text-accent-brand-pressed'
                : 'border-border-subtle bg-surface-panel text-ink-muted enabled:hover:text-ink-default',
            ].join(' ')}
          >
            <span aria-hidden>{emoji}</span>
            <span aria-hidden>{who.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The quick reactions at the top of a message's actions menu, for someone who can comment; `separated` when items follow. */
export function QuickReactions({ noteId, comment, separated }: { noteId: string; comment: { id: string }; separated: boolean }): ReactNode {
  const commentable = useCanComment(noteId);
  if (!commentable) return null;
  const me = myPrincipalId();
  const used = new Map(reactionsOf(comment));
  return (
    <>
      <div className="flex items-center gap-0.5 px-1 py-0.5">
        {QUICK.map((emoji) => {
          const mine = me !== null && (used.get(emoji)?.includes(me) ?? false);
          return (
            <DropdownMenuItem
              key={emoji}
              aria-label={`React with ${emoji}`}
              onSelect={() => react(noteId, comment.id, emoji, !mine)}
              className={`h-7 w-7 justify-center rounded p-0 text-sm ${mine ? 'bg-accent-brand/10' : ''}`}
            >
              {emoji}
            </DropdownMenuItem>
          );
        })}
      </div>
      {separated ? <DropdownMenuSeparator /> : null}
    </>
  );
}
