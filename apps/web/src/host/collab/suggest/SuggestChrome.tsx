// Suggest-mode chrome (docs/design/suggestions.md §5, §8): the Suggest toggle in moss's docked toolbar for editors
// and owners, the top bar's "Suggesting" chip (locked for a suggester) and Review switch, the band shown in Review,
// and the band that offers back text a closed suggestion could not keep.
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { REVIEW_BAND_ATTR, SUGGEST_CHIP_ATTR, SUGGEST_TOGGLE_ATTR, SUGGEST_UNSAVED_ATTR } from '@moss-multi/protocol/dom-contract';
import { can, type Role } from '@moss-multi/protocol/roles';
import { PencilLine } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useDocRole } from '../../access.ts';
import { useTerminal } from '../terminal.ts';
import { dismissUnsaved, lockedToSuggest, requestMode, useNoSuggestionRoom, useOpenSuggestions, useShownMode, useUnsaved } from './mode.ts';

const TOOL = 'flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-border-clear px-2 text-xs text-ink-default transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/15 active:scale-90';
const IDLE = 'hover:border-border-subtle hover:bg-surface-sidebar';
const ACCENT = 'bg-surface-note-hover text-ink-default';

/**
 * MarkdownEditor's suggest-toggle seam: a small shell docked at the right of moss's bottom toolbar, positioned out
 * of its flow so moss's own bar keeps its layout. In it, an editor or owner switches between Edit and Suggest.
 */
export function ToolbarCollab({ noteId }: { noteId: string }): ReactNode {
  const role = useDocRole(noteId);
  const mode = useShownMode(noteId);
  if (!can(role, 'edit') || mode === null || mode === 'review') return null;
  const on = mode === 'suggest';
  return (
    <TooltipProvider><Tooltip><div data-suggest-dock="" className="pointer-events-auto absolute bottom-1 left-full ml-1 inline-flex max-sm:bottom-full max-sm:left-auto max-sm:right-0 max-sm:mb-2">
      <TooltipTrigger asChild><button
        type="button"
        {...{ [SUGGEST_TOGGLE_ATTR]: '' }}
        aria-label="Suggest changes"
        aria-pressed={on}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => requestMode(noteId, on ? 'edit' : 'suggest')}
        className={`${TOOL} ${on ? ACCENT : `${IDLE} w-8 px-0`}`}
      >
        <PencilLine aria-hidden className="h-4 w-4" strokeWidth={1.5} />
        {on && <span>Suggesting</span>}
      </button></TooltipTrigger>
    </div><TooltipContent side="top">{on ? 'Suggesting changes — click to edit directly' : 'Suggest changes instead of editing'}</TooltipContent></Tooltip></TooltipProvider>
  );
}

/** In the top bar: "Suggesting" while the pane suggests (locked for a suggester). */
export function SuggestModeChip({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  if (mode !== 'suggest' || role === null) return null;
  const locked = lockedToSuggest(role);
  return (
    <span
      data-collab-chrome=""
      {...{ [SUGGEST_CHIP_ATTR]: locked ? 'locked' : 'unlocked' }}
      title={locked ? 'You can suggest changes to this note' : 'Your changes are proposed as suggestions'}
      className="flex shrink-0 items-center px-2 py-1 text-micro text-ink-muted"
    >
      Suggesting
    </span>
  );
}

/** Leaves Review for the role's own mode: Suggest for a suggester, otherwise the plain body. */
export const leaveReview = (docId: string, role: Role | null): void => requestMode(docId, lockedToSuggest(role) ? 'suggest' : 'edit');

/**
 * In the top bar, from 640 px up, for those who can edit or suggest: the Review switch, offered only while the note
 * has an open suggestion or the pane is already in Review (T9.1). Viewers and commenters switch from the list header.
 */
export function ReviewButton({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  const open = useOpenSuggestions(docId);
  const reviewing = mode === 'review';
  if (mode === null || !can(role, 'suggest') || (!reviewing && open === 0)) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-collab-chrome=""
            aria-label="Review suggestions"
            aria-pressed={reviewing}
            onClick={() => (reviewing ? leaveReview(docId, role) : requestMode(docId, 'review'))}
            className={`hidden h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none sm:flex ${reviewing ? 'bg-surface-panel text-ink-default' : 'text-ink-faint hover:bg-surface-note-hover/40 hover:text-ink-muted'}`}
          >
            Review
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{reviewing ? 'Done reviewing' : 'Review suggestions'}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Surfaces whose own Escape comes first: popovers, dialogs, menus, the find bar. */
const ESCAPE_OWNERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-moss-note-search-input]';
const escapeOwned = (): boolean => [...document.querySelectorAll(ESCAPE_OWNERS)].some((el) => el.getClientRects().length > 0);

/**
 * Moss's bottom band (its Trash notice, CanvasAreaContent) while someone who can edit or suggest is in Review: why
 * typing does nothing, and Done. Escape does what Done does unless something else handles it.
 */
export function ReviewBand({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  const terminal = useTerminal(docId);
  const shown = mode === 'review' && can(role, 'suggest') && terminal === null;
  useEffect(() => {
    if (!shown) return;
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
  }, [docId, role, shown]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none absolute bottom-8 left-1/2 z-40 w-max max-w-[calc(100%-2rem)] -translate-x-1/2">
      <div {...{ [REVIEW_BAND_ATTR]: '' }} className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border-subtle/50 bg-surface-raised-card px-4 py-2.5 shadow-floating backdrop-blur-sm">
        <span className="text-xs text-ink-muted">
          Reviewing suggestions · typing paused{' '}
          <button type="button" onClick={() => leaveReview(docId, role)} className="font-medium text-ink-default hover:text-ink-muted">
            Done
          </button>
        </span>
      </div>
    </div>
  );
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
