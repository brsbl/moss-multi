// Where a remote typing label goes (T9.32): never over the text column, in the whitespace gutter on the caret's side
// with 8 px clearance, else the opposite gutter, else nowhere in the text (the People here region names them).
import { expect, it } from 'vitest';
import { placeLabels, type LabelRequest } from './label-place.ts';

const column = { left: 420, right: 1270 };
const bounds = { left: 253, right: 1440 };
const req = (id: number, caretX: number, caretTop: number, width = 70): LabelRequest => ({ id, caretX, caretTop, caretHeight: 23, width, height: 24, column });

it('a caret in the left half of the column puts its name in the left gutter, 8 px clear of the text', () => {
  const { placed, unplaced } = placeLabels([req(1, 600, 200)], bounds);
  expect(unplaced).toEqual([]);
  const at = placed.get(1)!;
  expect(at.x + 70).toBe(column.left - 8);
  expect(at.y).toBeCloseTo(200 - 0.5);
});

it('a caret in the right half goes to the right gutter', () => {
  const at = placeLabels([req(1, 1100, 200)], bounds).placed.get(1)!;
  expect(at.x).toBe(column.right + 8);
});

it('no label rectangle ever intersects the text column', () => {
  const { placed } = placeLabels([req(1, 430, 100), req(2, 1260, 100), req(3, 800, 300, 160)], bounds);
  for (const [, at] of placed) {
    const right = at.x + (at.id === 3 ? 160 : 70);
    expect(right <= column.left - 8 || at.x >= column.right + 8).toBe(true);
  }
});

it('a full preferred gutter falls back to the opposite one, then to the People here region', () => {
  const narrowLeft = { left: 380, right: 1440 };
  const at = placeLabels([req(1, 500, 200)], narrowLeft).placed.get(1)!;
  expect(at.x).toBe(column.right + 8);
  const phone = { left: 0, right: 390 };
  const result = placeLabels([{ ...req(1, 100, 200), column: { left: 16, right: 374 } }], phone);
  expect(result.placed.size).toBe(0);
  expect(result.unplaced).toEqual([1]);
});

it('labels on neighbouring lines never overlap: the second takes the other gutter, a third is aggregated', () => {
  const { placed, unplaced } = placeLabels([req(1, 500, 200), req(2, 520, 205), req(3, 540, 210)], bounds);
  const one = placed.get(1)!; const two = placed.get(2)!;
  expect(one.x).toBeLessThan(column.left);
  expect(two.x).toBeGreaterThan(column.right);
  expect(unplaced).toEqual([3]);
});
