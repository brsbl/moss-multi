// Suggest-mode chrome (docs/design/suggestions.md §5, §8): the pane's bottom row while suggesting (Stop suggesting
// for editors and owners; a suggester is locked), in Moss's docked toolbar while it shows; the row shown in Review;
// and the band that offers back text a closed suggestion could not keep. Suggest changes and Review start from More
// actions and the Suggestions list.
import { MODE_ROW_ATTR, REVIEW_BAND_ATTR, SUGGEST_CHIP_ATTR, SUGGEST_UNSAVED_ATTR } from '@moss-multi/protocol/dom-contract';
import { can, type Role } from '@moss-multi/protocol/roles';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useDocRole } from '../../access.ts';
import { BOTTOM_ROW, BOTTOM_ROW_ACTION, BOTTOM_ROW_SLOT, useAttachedRow, useRowAttached } from '../bottom-row.ts';
import { useTerminal } from '../terminal.ts';
import { dismissUnsaved, lockedToSuggest, requestMode, reviewReturn, useNoSuggestionRoom, usePausedMode, useShownMode, useUnsaved } from './mode.ts';

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
 */
export function ToolbarCollab({ noteId }: { noteId: string }): ReactNode {
  return useSuggesting(noteId) ? <AttachedRow docId={noteId} /> : null;
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
export function ReviewRow({ docId, role, text, reader = false, attrs, children = null }: {
  docId: string; role: Role | null; text: string; reader?: boolean; attrs: Record<string, string>; children?: ReactNode;
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

/** In the notice band: what a closed suggestion could not keep, until dismissed (§5 refusal path). */
export function SuggestUnsavedBand({ docId }: { docId: string | null }): ReactNode {
  const blocks = useUnsaved(docId);
  const full = useNoSuggestionRoom(docId);
  const [copied, setCopied] = useState(false);
  if (!docId || (blocks.length === 0 && !full)) return null;
  const text = blocks.join('\n\n');
  return (
    <div {...{ [SUGGEST_UNSAVED_ATTR]: '' }} role="alert" className="flex items-center gap-3 border-b border-border-subtle bg-surface-raised-card px-4 py-2 text-xs text-ink-default">
      <span className="min-w-0 flex-1">
        {full
          ? `This note has no room for more suggestions${blocks.length ? ', so your last changes were not saved' : ''}. An editor can still edit it.`
          : 'This suggestion was closed while you typed, so your last changes were not saved.'}
      </span>
      {blocks.length ? (
        <button
          type="button"
          className="underline"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? 'Copied' : 'Copy what wasn’t saved'}
        </button>
      ) : null}
      <button type="button" className="text-ink-muted underline" onClick={() => { setCopied(false); dismissUnsaved(docId); }}>
        Dismiss
      </button>
    </div>
  );
}
