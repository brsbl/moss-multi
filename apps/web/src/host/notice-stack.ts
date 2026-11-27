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
  /**
   * The note stays closed here until the person acts: deleted, access ended, the session ended, unavailable or at its
   * limit, or a Suggest window refused its lease (until Retry).
   */
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

/** The connection's notice as the stack reads it (ConnectionNotice.tsx's useNotice). */
export interface ConnectionNoticeClassInput { kind: string; terminal: string | null }

/**
 * Where the connection's notice ranks (T9.56). A Suggest window refused its lease is read-only until the person asks
 * again, as at the connection limit, so its notice and Retry lead and text held meanwhile is one press away on it;
 * ranked as an outage it was hidden under the unsaved-text card. An outdated bundle is the update notice.
 */
export function classifyConnectionNotice(notice: ConnectionNoticeClassInput | null): Pick<NoticeInputs, 'terminal' | 'outage' | 'update'> {
  if (notice === null) return { terminal: false, outage: false, update: false };
  const busy = notice.kind === 'suggest-busy';
  const outdated = notice.terminal === 'outdated';
  return {
    terminal: busy || (notice.terminal !== null && !outdated),
    outage: notice.terminal === null && !busy,
    update: outdated,
  };
}
