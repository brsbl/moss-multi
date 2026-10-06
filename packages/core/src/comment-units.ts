// Create- and import-time unit arithmetic for comments (docs/design/comments.md §4): where an item sits in the
// root's text-mode unit order (characters, decorators and opaque embeds, as anchor-frame.ts counts them), without
// materialising a token per character, and the overlap sweep that keeps any character under OVERLAP_CAP comments.
// None of this runs per frame (I7): only at create, import and duplicate.
import * as Y from 'yjs';
import type { Unit } from './anchor-frame.ts';
import { BLOCK_CHAR } from './tree-anchor.ts';

/** Text-mode units an item holds: what anchor-frame's `own()` emits outside full mode. */
function unitCount(item: Y.Item): number {
  const content = item.content;
  if (content instanceof Y.ContentType) return content.type instanceof Y.XmlText || content.type instanceof Y.Map ? 0 : 1;
  if (content instanceof Y.ContentFormat || content instanceof Y.ContentDeleted) return 0;
  return item.length;
}

const listOf = (item: Y.Item): Y.XmlText | null =>
  item.content instanceof Y.ContentType && item.content.type instanceof Y.XmlText ? item.content.type : null;

/**
 * Visits every live unit-bearing item under `root` in flattened order (a block before its children), with the
 * ordinal of its first unit. Return false from `visit` to stop. Returns the units counted.
 */
export function walkUnits(doc: Y.Doc, visit: (item: Y.Item, units: number, ordinal: number) => boolean | void): number {
  let ordinal = 0;
  const stack: (Y.Item | null)[] = [doc.get('root', Y.XmlText)._start];
  while (stack.length) {
    const item = stack.pop();
    if (!item) continue;
    stack.push(item.right);
    if (item.deleted) continue;
    const units = unitCount(item);
    if (units > 0) {
      if (visit(item, units, ordinal) === false) return ordinal;
      ordinal += units;
    }
    const list = listOf(item);
    if (list) stack.push(list._start);
  }
  return ordinal;
}

/** The ordinal of each live unit named by `ids` ([client, clock]); a missing key means not a live root unit. */
export function ordinalsOf(doc: Y.Doc, ids: Iterable<Y.ID>): Map<string, number> {
  const wanted = new Map<number, number[]>();
  for (const { client, clock } of ids) wanted.set(client, [...(wanted.get(client) ?? []), clock]);
  for (const clocks of wanted.values()) clocks.sort((a, b) => a - b);
  const out = new Map<string, number>();
  if (!wanted.size) return out;
  walkUnits(doc, (item, units, ordinal) => {
    const clocks = wanted.get(item.id.client);
    if (!clocks) return;
    const from = item.id.clock;
    let lo = 0;
    let hi = clocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (clocks[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < clocks.length && clocks[i] < from + units; i += 1) out.set(`${item.id.client}:${clocks[i]}`, ordinal + clocks[i] - from);
  });
  return out;
}

export const idKey = (id: Y.ID): string => `${id.client}:${id.clock}`;

/** The live units at `ordinals`, keyed by ordinal. */
export function unitsAt(doc: Y.Doc, ordinals: Iterable<number>): Map<number, Unit> {
  const sorted = [...new Set(ordinals)].sort((a, b) => a - b);
  const out = new Map<number, Unit>();
  let next = 0;
  walkUnits(doc, (item, units, ordinal) => {
    while (next < sorted.length && sorted[next] < ordinal + units) {
      if (sorted[next] >= ordinal) out.set(sorted[next], { item, off: sorted[next] - ordinal });
      next += 1;
    }
    return next < sorted.length;
  });
  return out;
}

/** The live root's text-mode units as one string (a non-character unit reads as U+FFFC), for import's alignment check. */
export function unitText(doc: Y.Doc): string {
  const parts: string[] = [];
  walkUnits(doc, (item, units) => {
    parts.push(item.content instanceof Y.ContentString ? item.content.str : BLOCK_CHAR.repeat(units));
  });
  return parts.join('');
}

/** The most intervals [s, e] (inclusive) that cover any one unit of [from, to]. */
export function maxCoverage(intervals: Iterable<[number, number]>, from: number, to: number): number {
  const events: [at: number, delta: number][] = [];
  for (const [s, e] of intervals) {
    if (e < from || s > to) continue;
    events.push([Math.max(s, from), 1], [Math.min(e, to) + 1, -1]);
  }
  // At one position an interval that ended before it closes before one that starts there opens.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let max = 0;
  for (const [, delta] of events) {
    depth += delta;
    if (depth > max) max = depth;
  }
  return max;
}
