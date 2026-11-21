// Where a suggestion opened from its mark goes (T9.34): beside its line in the right margin only when that keeps every
// line of text clear, else the pane's Suggestions panel, docked at the right or filling a narrow pane.
import { expect, it } from 'vitest';
import { placeSuggestion, type Box, type PlaceInput } from './place.ts';

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const pane = box(253, 0, 1440, 1000);
const viewport = { width: 1440, height: 1000 };
// Short lines, as in a note of three short paragraphs: the right margin is free.
const short = [box(427, 160, 760, 184), box(427, 203, 780, 227), box(427, 246, 700, 270)];
const long = [box(427, 160, 1268, 184), box(427, 203, 1270, 227), box(427, 246, 1266, 270)];
const linesOf = (lines: Box[]) => (top: number, bottom: number) => lines.filter((line) => line.bottom > top && line.top < bottom);
const input = (over: Partial<PlaceInput>): PlaceInput => ({
  mark: box(690, 160, 730, 184), pane, barBottom: 44, viewport, height: 170, linesIn: linesOf(short), ...over,
});

it('with a free right margin the thread sits beside its line, 352 px wide and 16 px from the pane edge', () => {
  const at = placeSuggestion(input({}));
  expect(at).toEqual({ kind: 'beside', side: 'bottom', right: 1424, width: 352, maxHeight: 600 });
});

it('no line of text under the thread: its x range clears every line it spans by 8 px', () => {
  const at = placeSuggestion(input({}));
  if (at.kind !== 'beside') throw new Error('beside');
  for (const line of short) expect(line.right).toBeLessThanOrEqual(at.right - at.width - 8);
});

it('without room below the line it goes above it, still clear of the text', () => {
  const at = placeSuggestion(input({ mark: box(690, 900, 730, 924), linesIn: linesOf([...short, box(427, 900, 760, 924)]) }));
  expect(at).toMatchObject({ kind: 'beside', side: 'top' });
});

it('when the margin would cover the next line it opens the panel docked at the right, under the top bar', () => {
  const at = placeSuggestion(input({ linesIn: linesOf(long), mark: box(500, 160, 540, 184) }));
  expect(at).toEqual({ kind: 'docked', left: 1072, top: 52, width: 352, maxHeight: 600 });
});

it('a docked panel that would cover its own source fills the pane instead', () => {
  const at = placeSuggestion(input({ linesIn: linesOf(long), mark: box(1100, 160, 1150, 184) }));
  expect(at).toEqual({ kind: 'pane', left: 253, top: 44, width: 1187, maxHeight: 956 });
});

it('a 390 px pane has no margin and no room for a docked panel: the suggestion fills the pane', () => {
  const narrow = box(0, 0, 390, 844);
  const at = placeSuggestion(input({
    pane: narrow, viewport: { width: 390, height: 844 }, mark: box(100, 160, 140, 184), linesIn: linesOf([box(16, 160, 370, 184), box(16, 203, 300, 227)]),
  }));
  expect(at).toEqual({ kind: 'pane', left: 0, top: 44, width: 390, maxHeight: 800 });
});

it('the thread is never wider than the pane or the screen less 32 px', () => {
  const at = placeSuggestion(input({ pane: box(0, 0, 360, 1000), viewport: { width: 360, height: 1000 }, linesIn: () => [] }));
  expect(at).toMatchObject({ kind: 'beside', width: 328, right: 344 });
});

it('a tall thread is capped at 60% of the screen and the room on its side', () => {
  const at = placeSuggestion(input({ height: 2000 }));
  expect(at).toMatchObject({ kind: 'beside', maxHeight: 600 });
  const low = placeSuggestion(input({ height: 2000, mark: box(690, 600, 730, 624), linesIn: () => [] }));
  // 352 px below, 540 above: the taller side, capped by its room.
  expect(low).toMatchObject({ kind: 'beside', side: 'top', maxHeight: 600 - 8 - 52 });
});
