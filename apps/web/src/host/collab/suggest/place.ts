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

export function placeSuggestion({ mark, viewport }: PlaceInput): Placement {
  // Not built yet: below the mark, as before.
  return { kind: 'beside', side: 'bottom', right: mark.left + THREAD_WIDTH, width: THREAD_WIDTH, maxHeight: Math.floor(viewport.height * 0.6) };
}
