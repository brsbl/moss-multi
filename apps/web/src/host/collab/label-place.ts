// Where a remote typing name goes (T9.32). Never over the note's text, the title or the line being typed: in the
// whitespace gutter beside the caret's line, on the caret's side first, then the other side, 8 px clear of the text
// and of the visible edge. A name with no room in either gutter is left to the People here region ("N typing").

export interface LabelRequest {
  id: number;
  /** The caret's x and its line's top and height, in viewport px. */
  caretX: number; caretTop: number; caretHeight: number;
  /** The label's own size. */
  width: number; height: number;
  /** The text column of the caret's line. */
  column: { left: number; right: number };
}
export interface Placement { id: number; x: number; y: number }

export const GUTTER_CLEARANCE = 8;
/** Vertical space kept between two names in one gutter. */
const STACK_GAP = 2;

export function placeLabels(requests: LabelRequest[], bounds: { left: number; right: number }, gap = GUTTER_CLEARANCE): {
  placed: Map<number, Placement>; unplaced: number[];
} {
  const placed = new Map<number, Placement>();
  const unplaced: number[] = [];
  const taken: Record<'left' | 'right', { top: number; bottom: number }[]> = { left: [], right: [] };
  const ordered = [...requests].sort((a, b) => a.caretTop - b.caretTop || a.id - b.id);
  for (const request of ordered) {
    const { column, width, height } = request;
    const y = request.caretTop + (request.caretHeight - height) / 2;
    const free = (side: 'left' | 'right') => taken[side].every((r) => y + height + STACK_GAP <= r.top || r.bottom + STACK_GAP <= y);
    const fits = {
      left: column.left - gap - width >= bounds.left + gap,
      right: column.right + gap + width <= bounds.right - gap,
    };
    const near: 'left' | 'right' = request.caretX - column.left <= (column.right - column.left) / 2 ? 'left' : 'right';
    const side = ([near, near === 'left' ? 'right' : 'left'] as const).find((s) => fits[s] && free(s));
    if (!side) { unplaced.push(request.id); continue; }
    taken[side].push({ top: y, bottom: y + height });
    placed.set(request.id, { id: request.id, x: side === 'left' ? column.left - gap - width : column.right + gap, y });
  }
  return { placed, unplaced };
}
