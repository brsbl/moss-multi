// Where a suggestion opened from its mark goes (T9.34). As Moss's comment thread, it sits beside its line in the
// pane's right margin when the margin holds it clear of every line of text, below the line or, without room there,
// above it. When no such place keeps the text legible it opens in the pane's Suggestions panel with Back to note:
// docked at the pane's right, with the note reflowed beside it, or, in a pane too narrow for that, filling the pane.

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
/** A pane narrower than this always opens the suggestion as its single view. */
const NARROW = 640;

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

export function placeSuggestion(input: PlaceInput): Placement {
  const { mark, pane, barBottom, viewport, height, linesIn } = input;
  if (pane.right - pane.left < NARROW) return panelPlacement(input);
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
  return panelPlacement(input);
}

/**
 * The Suggestions panel: docked at the pane's right under its top bar while the pane keeps room for the note beside
 * it (the pane reserves its width, so the note reflows and no line is under it), else filling the pane.
 */
export function panelPlacement({ pane, barBottom, viewport }: Pick<PlaceInput, 'pane' | 'barBottom' | 'viewport'>): Placement {
  const right = Math.min(pane.right, viewport.width) - MARGIN;
  const width = Math.max(0, Math.min(THREAD_WIDTH, pane.right - pane.left - 2 * MARGIN, viewport.width - 2 * MARGIN));
  const top = Math.max(barBottom, pane.top, 0) + GAP;
  const floor = Math.min(pane.bottom, viewport.height) - MARGIN;
  if (pane.right - pane.left >= NARROW && pane.right - pane.left >= width + 2 * MARGIN + MIN_NOTE) {
    return { kind: 'docked', left: right - width, top, width, maxHeight: Math.min(Math.floor(viewport.height * 0.6), floor - top) };
  }
  const paneTop = Math.max(barBottom, pane.top);
  return { kind: 'pane', left: pane.left, top: paneTop, width: pane.right - pane.left, maxHeight: Math.min(pane.bottom, viewport.height) - paneTop };
}

/** The width a docked panel at `placement` takes from the pane's right edge, its margin included. */
export function dockReserve(pane: Box, placement: Placement): number {
  return placement.kind === 'docked' ? Math.max(0, Math.ceil(pane.right - placement.left + MARGIN)) : 0;
}
