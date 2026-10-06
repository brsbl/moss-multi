// T5.3s: building a suggestion's preview (the DocDO path) and its card is linear in the record. At the record cap
// (SUGGEST_CAPS.recordOpsBytes), doubling a forged record roughly doubles the time and the rows' size, and the rows
// never outgrow the record and its hunks by more than a constant: no row repeats a subtree, an enclosing link's
// fields or a text node's fields once per run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { canonical, type Hunk, type RecordOp } from '@moss-multi/core/suggest/apply';
import { describeHunks } from '@moss-multi/core/suggest/describe';
import { SUGGEST_CAPS } from '../doc/suggest.ts';
import { previewRecord } from './review.ts';
import { deterministicIds, forgeRecord, hunksOf, opOn, seededBody } from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
const blocks = (doc: Y.Doc) => (root(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert);
const paragraph = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlText) as Y.XmlText;
const textMap = (doc: Y.Doc) => (paragraph(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.Map) as Y.Map<unknown>;

const textNode = (format = 0) => new Y.Map<unknown>([['__type', 'text'], ['__format', format], ['__style', ''], ['__mode', 'normal'], ['__detail', 0]]);

interface Shape {
  name: string;
  /** An editor's change to the note before the record, sized with it. */
  prepare?: (live: Y.Doc, n: number) => void;
  write: (n: number) => (doc: Y.Doc) => void;
}

const SHAPES: Shape[] = [
  {
    name: 'many new blocks, each after the last',
    write: (n) => (doc) => {
      for (let i = 0; i < n; i++) {
        const block = new Y.XmlText();
        root(doc).insertEmbed(1 + i, block);
        block.setAttribute('__type', 'paragraph');
        block.insertEmbed(0, textNode());
        block.insert(1, `block ${i} text`);
      }
    },
  },
  {
    name: 'blocks nested 200 deep, text at every level',
    write: (n) => (doc) => {
      const per = n;
      let parent = new Y.XmlText();
      root(doc).insertEmbed(1, parent);
      for (let depth = 0; depth < 200; depth++) {
        parent.setAttribute('__type', depth % 2 ? 'listitem' : 'list');
        parent.insertEmbed(0, textNode());
        parent.insert(1, 'd'.repeat(per));
        const child = new Y.XmlText();
        parent.insertEmbed(parent.length, child);
        parent = child;
      }
      parent.setAttribute('__type', 'paragraph');
    },
  },
  {
    name: 'many formatted runs inside a link with a long url',
    write: (n) => (doc) => {
      const block = new Y.XmlText();
      root(doc).insertEmbed(1, block);
      block.setAttribute('__type', 'paragraph');
      const link = new Y.XmlText();
      block.insertEmbed(0, link);
      link.setAttribute('__type', 'link');
      link.setAttribute('__url', `https://example.invalid/${'u'.repeat(4 * n)}`);
      for (let i = 0; i < n; i++) {
        link.insertEmbed(link.length, textNode(i % 2));
        link.insert(link.length, 'ab');
      }
    },
  },
  {
    name: 'single characters typed between the characters of a long-styled text node',
    prepare: (live, n) => {
      textMap(live).set('__style', `color: ${'s'.repeat(Math.ceil(n / 16))}`);
      paragraph(live).insert(1, 'y'.repeat(n));
    },
    write: (n) => (doc) => {
      for (let i = 0; i < n; i++) paragraph(doc).insert(2 + 2 * i, 'z');
    },
  },
];

const bytesOf = (ops: RecordOp[]) => ops.reduce((sum, op) => sum + op.update.byteLength, 0);

/** The fastest of a few runs, in ms. */
function fastest(run: () => void, times = 3): number {
  let best = Infinity;
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

interface Measure {
  bytes: number;
  hunkBytes: number;
  rowBytes: number;
  preview: number;
  card: number;
}

function measure(shape: Shape, n: number): Measure {
  const live = seededBody();
  shape.prepare?.(live, n);
  const ops = [opOn(live, 'body', shape.write(n))];
  forgeRecord(live, 'g', ops);
  const hunks: Hunk[] = hunksOf(live, ops);
  let rowBytes = 0;
  const card = fastest(() => {
    rowBytes = 0;
    for (const row of describeHunks(hunks)) rowBytes += row.text.length + (row.note?.length ?? 0) + row.detail.length;
  });
  const preview = fastest(() => {
    previewRecord(live, 'g');
  });
  return { bytes: bytesOf(ops), hunkBytes: canonical(hunks).length, rowBytes, preview, card };
}

/** The size whose doubled record is just under the cap, from the record's bytes at two probe sizes. */
function sizeAtCap(shape: Shape): number {
  const bytesAt = (n: number) => {
    const live = seededBody();
    shape.prepare?.(live, n);
    return bytesOf([opOn(live, 'body', shape.write(n))]);
  };
  const [a, b] = [bytesAt(64), bytesAt(128)];
  const slope = (b - a) / 64;
  return Math.floor((SUGGEST_CAPS.recordOpsBytes * 0.9 - (a - 64 * slope)) / slope / 2);
}

describe('T5.3s preview and card cost is linear in the record, at the record cap @p:mean-2 @p:R17', () => {
  it.each(SHAPES)('$name', (shape) => {
    const n = sizeAtCap(shape);
    const small = measure(shape, n);
    const large = measure(shape, 2 * n);
    const report = JSON.stringify({ n, small, large });
    expect(large.bytes, `the doubled record fits the cap: ${report}`).toBeLessThanOrEqual(SUGGEST_CAPS.recordOpsBytes);
    expect(large.bytes, `the doubled record is near the cap: ${report}`).toBeGreaterThan(SUGGEST_CAPS.recordOpsBytes * 0.5);
    // What a card renders stays within a constant of what it reads.
    for (const m of [small, large]) expect(m.rowBytes, `rows outgrow the record: ${report}`).toBeLessThanOrEqual(48 * (m.bytes + m.hunkBytes));
    expect(large.rowBytes, `rows grow faster than the record: ${report}`).toBeLessThanOrEqual(2.5 * small.rowBytes);
    expect(large.card, `card time grows faster than the record: ${report}`).toBeLessThanOrEqual(3 * small.card + 25);
    expect(large.preview, `preview time grows faster than the record: ${report}`).toBeLessThanOrEqual(3 * small.preview + 25);
  }, 240_000);
});
