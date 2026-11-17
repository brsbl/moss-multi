// Suggest-mode chrome (docs/design/suggestions.md §5, §8): the pane's bottom row while suggesting (Stop suggesting
// for editors and owners; a suggester is locked), the band shown in Review, and the band that offers back text a
// closed suggestion could not keep. Suggest changes and Review start from More actions and the Suggestions list.
import { MODE_ROW_ATTR, REVIEW_BAND_ATTR, SUGGEST_CHIP_ATTR, SUGGEST_UNSAVED_ATTR } from '@moss-multi/protocol/dom-contract';
import { can, type Role } from '@moss-multi/protocol/roles';
import { useEffect, useState, type ReactNode } from 'react';
import { useDocRole } from '../../access.ts';
import { useTerminal } from '../terminal.ts';
import { dismissUnsaved, lockedToSuggest, requestMode, useNoSuggestionRoom, useShownMode, useUnsaved } from './mode.ts';

/**
 * MarkdownEditor's suggest-toggle seam. Suggest changes is a More actions entry and the one Suggesting state is the
 * pane's bottom row (T9.30), so the docked toolbar adds no control of its own.
 */
export const ToolbarCollab: (props: { noteId: string }) => ReactNode = () => null;

/**
 * The pane's bottom row while it suggests: "Suggesting", and for someone who may edit, Stop suggesting. It sits just
 * above where Moss's docked toolbar shows while typing, so the two never overlap.
 */
export function SuggestBand({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  const terminal = useTerminal(docId);
  if (mode !== 'suggest' || role === null || terminal !== null) return null;
  const locked = lockedToSuggest(role);
  return (
    <div {...{ [MODE_ROW_ATTR]: '' }} className="pointer-events-none absolute bottom-20 left-1/2 z-40 w-max max-w-[calc(100%-2rem)] -translate-x-1/2">
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-border-subtle/50 bg-surface-raised-card px-4 py-2.5 shadow-floating backdrop-blur-sm">
        <span {...{ [SUGGEST_CHIP_ATTR]: locked ? 'locked' : 'unlocked' }} className="text-xs text-ink-muted">Suggesting</span>
        {locked ? null : (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => requestMode(docId, 'edit')}
            className="shrink-0 text-xs font-medium text-ink-default hover:text-ink-muted"
          >
            Stop suggesting
          </button>
        )}
      </div>
    </div>
  );
}

/** Leaves Review for the role's own mode: Suggest for a suggester, otherwise the plain body. */
export const leaveReview = (docId: string, role: Role | null): void => requestMode(docId, lockedToSuggest(role) ? 'suggest' : 'edit');

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
          {lockedToSuggest(role) ? 'Reviewing suggestions. Suggesting is paused.' : 'Reviewing suggestions. Click a change to accept or reject it. Editing is paused.'}{' '}
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
