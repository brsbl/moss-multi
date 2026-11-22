// Reactions on a comment (PRODUCT: from glyphdown, not in moss desktop; docs/design/comments.md §12). Glyphdown's
// interaction, built from moss's DS: each emoji someone used shows as a quiet chip under the message with its count,
// pressed when it includes you, and a click toggles your own; one Add reaction action beside the message's actions opens
// moss's menu with glyphdown's five quick reactions in a row. The records carry principal ids; the server adds or
// removes only the caller's.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { SmilePlus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { react, useCanComment } from './adapter.ts';
import { myPrincipalId } from './people.ts';

/** Glyphdown's quick reactions. */
export const QUICK = ['👍', '❤️', '🎉', '👀', '😄'] as const;

const reactionsOf = (comment: unknown): [string, string[]][] => {
  const value = (comment as { reactions?: unknown } | null)?.reactions;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0);
};

/** The chips under a message; nothing when nobody has reacted. Moss's comment count recipe: no border, faint ink. */
export function CommentReactions({ noteId, comment }: { noteId: string; comment: { id: string } }): ReactNode {
  const commentable = useCanComment(noteId);
  const entries = reactionsOf(comment);
  if (!entries.length) return null;
  const me = myPrincipalId();
  return (
    <div data-comment-reactions className="-ml-1.5 mt-1 flex flex-wrap items-center gap-0.5">
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
              'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-caption leading-none tabular-nums transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-default',
              mine ? 'bg-surface-panel text-ink-muted' : 'text-ink-faint enabled:hover:bg-surface-panel enabled:hover:text-ink-muted',
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

/**
 * One message's Add reaction: moss's 24 px thread action (14 px glyph), faint at rest and full while the message is
 * hovered or focused, or on a touch screen; it opens moss's menu with the quick reactions in a row, which arrows,
 * Home and End move through and Escape closes back to this button. Only for someone who can comment.
 */
export function AddReaction({ noteId, comment }: { noteId: string; comment: { id: string } }): ReactNode {
  const commentable = useCanComment(noteId);
  const [open, setOpen] = useState(false);
  if (!commentable) return null;
  const me = myPrincipalId();
  const used = new Map(reactionsOf(comment));
  return (
    <DropdownMenu modal={false} orientation="horizontal" open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-comment-add-reaction
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint opacity-50 transition-[color,background-color,opacity] hover:bg-surface-panel hover:text-ink-muted focus:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ink-default/15 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label="Add reaction"
            >
              <SmilePlus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {!open && (
          <TooltipContent side="bottom" sideOffset={4}>
            Add reaction
          </TooltipContent>
        )}
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} collisionPadding={8} aria-label="Add reaction" className="flex min-w-0 w-max flex-row gap-0.5">
        {QUICK.map((emoji) => {
          const mine = me !== null && (used.get(emoji)?.includes(me) ?? false);
          return (
            <DropdownMenuItem
              key={emoji}
              aria-label={`React with ${emoji}`}
              data-mine={mine || undefined}
              onSelect={() => react(noteId, comment.id, emoji, !mine)}
              className="h-7 w-7 justify-center p-0 text-sm data-[mine]:bg-surface-panel"
            >
              {emoji}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
