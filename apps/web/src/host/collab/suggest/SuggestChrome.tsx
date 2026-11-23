// Suggest-mode chrome (docs/design/suggestions.md §5, §8): the pane's bottom row while suggesting (Stop suggesting
// for editors and owners; a suggester is locked), in Moss's docked toolbar while it shows; and the row shown in Review.
// Suggest changes and Review start from More actions and the Suggestions list. Text a closed suggestion could not keep
// is offered back by UnsavedCard.
import { MODE_ROW_ATTR, REVIEW_BAND_ATTR, SUGGEST_CHIP_ATTR } from '@moss-multi/protocol/dom-contract';
import { can, type Role } from '@moss-multi/protocol/roles';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { useEffect, useId, type ReactNode } from 'react';
import { useDocRole } from '../../access.ts';
import { BOTTOM_ROW, BOTTOM_ROW_ACTION, BOTTOM_ROW_SLOT, useAttachedRow, useRowAttached, useToolbarProbe } from '../bottom-row.ts';
import { useTerminal } from '../terminal.ts';
import { lockedToSuggest, requestMode, reviewReturn, usePausedMode, useShownMode } from './mode.ts';

/** "Suggesting", and for someone who may edit, Stop suggesting: the one Suggesting state and its exit. */
function SuggestRow({ docId, className }: { docId: string; className: string }): ReactNode {
  const role = useDocRole(docId);
  const locked = lockedToSuggest(role);
  return (
    <div {...{ [MODE_ROW_ATTR]: '' }} className={className}>
      <span {...{ [SUGGEST_CHIP_ATTR]: locked ? 'locked' : 'unlocked' }}>Suggesting</span>
      {locked ? null : (
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => requestMode(docId, 'edit')} className={BOTTOM_ROW_ACTION}>
          Stop suggesting
        </button>
      )}
    </div>
  );
}

const useSuggesting = (docId: string): boolean => {
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  const terminal = useTerminal(docId);
  return mode === 'suggest' && role !== null && terminal === null;
};

/**
 * MarkdownEditor's suggest-toggle seam, inside Moss's docked toolbar column: while the pane suggests, the Suggesting
 * row joins the toolbar as its last line, nearest the bottom (T9.30). Suggest changes itself is a More actions entry.
 * Its probe reports the toolbar's height, so the pane's connection notice stands above it (T9.40).
 */
export function ToolbarCollab({ noteId }: { noteId: string }): ReactNode {
  const probe = useToolbarProbe(noteId);
  const suggesting = useSuggesting(noteId);
  return (
    <>
      <span ref={probe} hidden />
      {suggesting ? <AttachedRow docId={noteId} /> : null}
    </>
  );
}

function AttachedRow({ docId }: { docId: string }): ReactNode {
  useAttachedRow(docId);
  return <SuggestRow docId={docId} className={`order-last -mt-1.5 ${BOTTOM_ROW}`} />;
}

/** The Suggesting row at the docked toolbar's place while the toolbar is away (the editor not focused). */
export function SuggestBand({ docId }: { docId: string }): ReactNode {
  const suggesting = useSuggesting(docId);
  const attached = useRowAttached(docId);
  if (!suggesting || attached) return null;
  return (
    <div className={BOTTOM_ROW_SLOT}>
      <SuggestRow docId={docId} className={BOTTOM_ROW} />
    </div>
  );
}

/** Leaves Review for the mode it paused, read from the current role: Suggest or Edit, or a reader's plain note. */
export const leaveReview = (docId: string, role: Role | null): void => requestMode(docId, reviewReturn(docId, role));

/** What Done does, said in its tooltip and as its accessible description (T9.33). */
const DONE_HELP = 'Return to your previous permitted mode. This does not accept or reject changes.';
const READER_DONE_HELP = 'Return to the plain note; your access stays the same';

/**
 * A Review row in the pane's bottom slot: what Review pauses, and Done with Moss's tooltip saying where it goes. The
 * description sits outside the row, so the row reads as its words and Done.
 */
export function ReviewRow({ docId, role, text, reader = false, attrs, children = null, outside = null }: {
  docId: string; role: Role | null; text: ReactNode; reader?: boolean; attrs: Record<string, string>; children?: ReactNode;
  /** Descriptions the row's own controls point at, kept out of its words. */
  outside?: ReactNode;
}): ReactNode {
  const help = reader ? READER_DONE_HELP : DONE_HELP;
  const id = useId();
  return (
    <div className={BOTTOM_ROW_SLOT}>
      <div {...attrs} className={BOTTOM_ROW}>
        <span>{text}</span>{' '}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-describedby={id} onClick={() => leaveReview(docId, role)} className={BOTTOM_ROW_ACTION}>
                Done
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{help}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {children}
      </div>
      <span id={id} hidden>{help}</span>
      {outside}
    </div>
  );
}

/** Surfaces whose own Escape comes first: popovers, dialogs, menus, the find bar. */
const ESCAPE_OWNERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-moss-note-search-input]';
const escapeOwned = (): boolean => [...document.querySelectorAll(ESCAPE_OWNERS)].some((el) => el.getClientRects().length > 0);

/** While `active`, Escape leaves Review for the role's own mode, unless something else handles it. */
export function useEscapeLeavesReview(docId: string, role: Role | null, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let owned = false;
    const capture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') owned = escapeOwned();
    };
    const bubble = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || owned) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      leaveReview(docId, role);
    };
    window.addEventListener('keydown', capture, true);
    window.addEventListener('keydown', bubble);
    return () => {
      window.removeEventListener('keydown', capture, true);
      window.removeEventListener('keydown', bubble);
    };
  }, [docId, role, active]);
}

/**
 * The pane's bottom row (T9.30) while someone who can edit or suggest is in Review, in place of the editing tools: the
 * mode Review paused, and Done back to it (T9.33). Escape does what Done does unless something else handles it. A reader's Review is
 * said in their own row (RoleBand).
 */
export function ReviewBand({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  const terminal = useTerminal(docId);
  const paused = usePausedMode(docId, role);
  const shown = mode === 'review' && can(role, 'suggest') && terminal === null;
  useEscapeLeavesReview(docId, role, shown);
  if (!shown) return null;
  const text = `Reviewing suggestions · ${paused === 'suggest' ? 'Suggesting paused' : 'Editing paused'}`;
  return <ReviewRow docId={docId} role={role} text={text} attrs={{ [REVIEW_BAND_ATTR]: '' }} />;
}
