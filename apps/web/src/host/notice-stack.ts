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
