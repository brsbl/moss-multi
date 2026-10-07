// Suggest-mode chrome (docs/design/suggestions.md §5, §8): the Suggest toggle in moss's docked toolbar for editors
// and owners, the top bar's "Suggesting" chip (locked for a suggester) and Review toggle, and the band that offers
// back text a closed suggestion could not keep.
import { SUGGEST_CHIP_ATTR, SUGGEST_TOGGLE_ATTR, SUGGEST_UNSAVED_ATTR } from '@moss-multi/protocol/dom-contract';
import { can } from '@moss-multi/protocol/roles';
import { Eye, PencilLine } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useDocRole } from '../../access.ts';
import { dismissUnsaved, lockedToSuggest, requestMode, useShownMode, useUnsaved } from './mode.ts';

const TOOL = 'flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-border-clear px-2 text-xs text-ink-default transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/15 active:scale-90';
const IDLE = 'hover:border-border-subtle hover:bg-surface-sidebar';
const ACCENT = 'border-accent-brand bg-surface-note-selected/70 text-accent-brand-pressed shadow-[inset_0_1px_2px_var(--ink-shadow-soft)]';

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
    <div data-suggest-dock="" className="pointer-events-auto absolute bottom-0 left-full -ml-2 inline-flex rounded-lg border border-border-subtle bg-surface-panel px-1.5 py-1 shadow-sm">
      <button
        type="button"
        {...{ [SUGGEST_TOGGLE_ATTR]: '' }}
        aria-label="Suggest changes"
        aria-pressed={on}
        title={on ? 'Suggesting: your changes are proposed, not applied' : 'Suggest changes instead of editing'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => requestMode(noteId, on ? 'edit' : 'suggest')}
        className={`${TOOL} ${on ? ACCENT : IDLE}`}
      >
        <PencilLine aria-hidden className="h-4 w-4" />
        <span>Suggest</span>
      </button>
    </div>
  );
}

/** In the top bar: "Suggesting" while the pane suggests (locked for a suggester), and Review for any role. */
export function SuggestModeChip({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  if (mode === null || role === null) return null;
  const locked = lockedToSuggest(role);
  const reviewing = mode === 'review';
  return (
    <>
      {mode === 'suggest' ? (
        <span
          data-collab-chrome=""
          {...{ [SUGGEST_CHIP_ATTR]: locked ? 'locked' : 'unlocked' }}
          title={locked ? 'You can suggest changes to this note' : 'Your changes are proposed as suggestions'}
          className="flex shrink-0 items-center rounded-full border border-accent-brand px-2 py-0.5 text-micro text-accent-brand-pressed"
        >
          Suggesting
        </span>
      ) : null}
      <button
        type="button"
        data-collab-chrome=""
        aria-label="Review suggestions"
        aria-pressed={reviewing}
        title={reviewing ? 'Back to the note' : 'Show pending suggestions inline'}
        onClick={() => requestMode(docId, reviewing ? (locked ? 'suggest' : 'edit') : 'review')}
        className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-micro ${reviewing ? 'border-accent-brand text-accent-brand-pressed' : 'border-border-subtle text-ink-muted hover:text-ink-default'}`}
      >
        <Eye aria-hidden className="h-3 w-3" />
        <span className="hidden sm:inline">Review</span>
      </button>
    </>
  );
}

/** In the notice band: what a closed suggestion could not keep, until dismissed (§5 refusal path). */
export function SuggestUnsavedBand({ docId }: { docId: string | null }): ReactNode {
  const blocks = useUnsaved(docId);
  const [copied, setCopied] = useState(false);
  if (!docId || blocks.length === 0) return null;
  const text = blocks.join('\n\n');
  return (
    <div {...{ [SUGGEST_UNSAVED_ATTR]: '' }} role="alert" className="flex items-center gap-3 border-b border-border-subtle bg-surface-raised-card px-4 py-2 text-xs text-ink-default">
      <span className="min-w-0 flex-1">This suggestion was closed while you typed, so your last changes were not saved.</span>
      <button
        type="button"
        className="underline"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        {copied ? 'Copied' : 'Copy what wasn’t saved'}
      </button>
      <button type="button" className="text-ink-muted underline" onClick={() => { setCopied(false); dismissUnsaved(docId); }}>
        Dismiss
      </button>
    </div>
  );
}
