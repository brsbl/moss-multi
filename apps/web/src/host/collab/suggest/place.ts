// Where a suggestion opened from its mark goes (T9.34). As Moss's comment thread, it sits beside its line in the
// pane's right margin when the margin holds it clear of every line of text, below the line or, without room there,
// above it. When no such place keeps the text legible it opens in the pane's Suggestions panel with Back to note:
// docked at the pane's right when that leaves its source line visible, else filling the pane as a single view.

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type Placement =
  | { readonly kind: 'beside'; readonly side: 'bottom' | 'top'; readonly right: number; readonly width: number; readonly maxHeight: number }
  | { readonly kind: 'docked' | 'pane'; readonly left: number; readonly top: number; readonly width: number; readonly maxHeight: number };

export const THREAD_WIDTH = 352;
const MARGIN = 16;
const GAP = 8;
/** Less room than this on either side of the line and the thread would be a sliver: it opens as the panel instead. */
const MIN_ROOM = 160;
/** A docked panel leaves at least this much of the pane for the note beside it. */
const MIN_NOTE = 480;

export interface PlaceInput {
  /** The clicked line of the suggestion. */
  readonly mark: Box;
  /** The pane, and the bottom of its top bar. */
  readonly pane: Box;
  readonly barBottom: number;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The thread's height as last drawn (an estimate before it is). */
  readonly height: number;
  /** The text line boxes between `top` and `bottom`: the title's and the body's. */
  readonly linesIn: (top: number, bottom: number) => readonly Box[];
}

export function placeSuggestion({ mark, pane, barBottom, viewport, height, linesIn }: PlaceInput): Placement {
  const right = Math.min(pane.right, viewport.width) - MARGIN;
  const width = Math.max(0, Math.min(THREAD_WIDTH, pane.right - pane.left - 2 * MARGIN, viewport.width - 2 * MARGIN));
  const left = right - width;
  const ceiling = Math.max(barBottom, pane.top, 0) + GAP;
  const floor = Math.min(pane.bottom, viewport.height) - MARGIN;
  const cap = Math.floor(viewport.height * 0.6);
  const below = floor - (mark.bottom + GAP);
  const above = mark.top - GAP - ceiling;
  const clearOf = (top: number, bottom: number, from: number, to: number) =>
    linesIn(top, bottom).every((line) => line.right <= from - GAP || line.left >= to + GAP);

  for (const side of below >= Math.min(cap, height) || below >= above ? (['bottom', 'top'] as const) : (['top', 'bottom'] as const)) {
    const room = side === 'bottom' ? below : above;
    if (room < MIN_ROOM) continue;
    const maxHeight = Math.min(cap, room);
    const shown = Math.min(height, maxHeight);
    const [top, bottom] = side === 'bottom' ? [mark.bottom + GAP, mark.bottom + GAP + shown] : [mark.top - GAP - shown, mark.top - GAP];
    if (clearOf(top, bottom, left, right)) return { kind: 'beside', side, right, width, maxHeight };
  }

  // The panel, docked at the pane's right under its top bar, when the note keeps room beside it and its source shows.
  const dockedTop = ceiling;
  const dockedHeight = Math.min(cap, floor - dockedTop, height);
  const coversMark = mark.right > left - GAP && mark.left < right + GAP && mark.bottom > dockedTop && mark.top < dockedTop + dockedHeight;
  if (pane.right - pane.left >= width + 2 * MARGIN + MIN_NOTE && !coversMark) {
    return { kind: 'docked', left, top: dockedTop, width, maxHeight: Math.min(cap, floor - dockedTop) };
  }
  // Too narrow, or it would cover its own source: it fills the pane under the top bar until Back to note.
  const top = Math.max(barBottom, pane.top);
  return { kind: 'pane', left: pane.left, top, width: pane.right - pane.left, maxHeight: Math.min(pane.bottom, viewport.height) - top };
}
