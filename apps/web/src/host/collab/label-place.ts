export interface LabelRequest {
  id: number; caretX: number; caretTop: number; caretHeight: number; width: number; height: number;
  column: { left: number; right: number };
}
export interface Placement { id: number; x: number; y: number }
export function placeLabels(requests: LabelRequest[], bounds: { left: number; right: number }): { placed: Map<number, Placement>; unplaced: number[] } {
  void bounds;
  return { placed: new Map(requests.map((r) => [r.id, { id: r.id, x: r.caretX, y: r.caretTop }])), unplaced: [] };
}
