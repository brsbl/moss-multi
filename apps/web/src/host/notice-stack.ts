// moss's bottom notices share one spot (A§19): the operation-failure toast is fixed at the window's bottom centre and
// the open note's Trash notice sits at the canvas's, so a refused restore covered the notice it is about (T3.B17).
import { RETENTION_NOTICE_ATTR } from '@moss-multi/protocol/dom-contract';

/** The gap a notice keeps above the open note's Trash notice. */
const NOTICE_GAP_PX = 8;

/** A ref for a fixed bottom notice: while a Trash notice shows, it stands above it, at any width the notice wraps to. */
export function standAboveTrashNotice(el: HTMLElement | null): void {
  if (!el) return;
  const trash = document.querySelector(`[${RETENTION_NOTICE_ATTR}]`);
  if (!trash) return;
  const below = window.innerHeight - trash.getBoundingClientRect().top + NOTICE_GAP_PX;
  el.style.bottom = `${Math.max(parseFloat(getComputedStyle(el).bottom) || 0, below)}px`;
}

/** A notice's action: Moss's text action in default ink (the agent bell's "Actions Panel"). */
export const NOTICE_ACTION = 'font-medium text-ink-default transition-colors hover:text-ink-muted';
/** A notice's Dismiss, quieter than its action. */
export const NOTICE_DISMISS = 'text-ink-faint transition-colors hover:text-ink-muted';

// The pane's notices (T9.41) take turns rather than stacking up: one card leads, in this order, and those it hides stay
// reachable from it. Precedence decides only what is shown; every payload stays in its own store until dismissed.
export type NoticeKind = 'terminal' | 'unsaved' | 'outage' | 'restore' | 'update';
export interface NoticeInputs {
  /** The note is closed for good here: deleted, access ended, the session ended, unavailable or at its limit. */
  terminal: boolean;
  /** Text a closed suggestion could not keep, or the note's no-room notice. */
  unsaved: boolean;
  /** The note is out of touch: its connection is lost or its first sync is late. */
  outage: boolean;
  /** Someone else restored an earlier version while the note was open here. */
  restore: boolean;
  /** This bundle is outdated and asks for a reload. */
  update: boolean;
  /** Moss's own Trash notice shows for the note, and is its terminal notice. */
  trashNotice: boolean;
}
export interface NoticeArrangement {
  lead: NoticeKind | null;
  /** The lead offers "Recover unsaved text (N)". */
  recover: boolean;
  /** The lead offers "Restore details" for a restore it hides. */
  restoreDetails: boolean;
}

const ORDER: readonly NoticeKind[] = ['terminal', 'unsaved', 'outage', 'restore', 'update'];

export function arrangeNotices(input: NoticeInputs): NoticeArrangement {
  const shown = { ...input, terminal: input.terminal && !input.trashNotice };
  const lead = ORDER.find((kind) => shown[kind]) ?? null;
  return { lead, recover: lead === 'terminal' && input.unsaved, restoreDetails: input.restore && lead !== null && lead !== 'restore' };
}
