// T5.3s: building a suggestion's preview (the DocDO path) and its card is linear in the record. At the record cap
// (SUGGEST_CAPS.recordOpsBytes), doubling a forged record roughly doubles the time and the rows' size, and the rows
// never outgrow the record and its hunks by more than a constant: no row repeats a subtree, an enclosing link's
// fields or a text node's fields once per run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { canonical, type DeletePart, type Hunk, type RecordOp } from '@moss-multi/core/suggest/apply';
import { describeHunks } from '@moss-multi/core/suggest/describe';
import { SUGGEST_CAPS } from '../doc/suggest.ts';
import { payloadDocsFor } from '../payload-docs.ts';
import { previewRecord } from './review.ts';
import { deterministicIds, forgeRecord, hunksOf, LEASED, opOn, seededBody, spansOfText } from './test-support.ts';

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
  /** A record the gates pass: its preview must succeed with hunks. */
  valid?: boolean;
  /** An editor's change to the note before the record, sized with it. */
  prepare?: (live: Y.Doc, n: number) => void;
  write: (n: number) => (doc: Y.Doc) => void;
}

const SHAPES: Shape[] = [
  {
    name: 'many new blocks, each after the last',
    valid: true,
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
    name: 'blocks nested 200 deep, each with a field and text',
    valid: true,
    write: (n) => (doc) => {
      const per = n;
      let parent = new Y.XmlText();
      root(doc).insertEmbed(1, parent);
      for (let depth = 0; depth < 200; depth++) {
        parent.setAttribute('__type', depth % 2 ? 'listitem' : 'list');
        parent.setAttribute('__indent', 1);
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
    valid: true,
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
    valid: true,
    prepare: (live, n) => {
      textMap(live).set('__style', `color: ${'s'.repeat(Math.ceil(n / 16))}`);
      paragraph(live).insert(1, 'y'.repeat(n));
    },
    write: (n) => (doc) => {
      for (let i = 0; i < n; i++) paragraph(doc).insert(2 + 2 * i, 'z');
    },
  },
  {
    name: 'a long field key holding many small maps',
    write: (n) => (doc) => {
      const block = new Y.XmlText();
      root(doc).insertEmbed(1, block);
      block.setAttribute('__type', 'paragraph');
      const holder = new Y.Map<unknown>();
      block.setAttribute(`__${'k'.repeat(n)}`, holder as never);
      for (let i = 0; i < n / 64; i++) holder.set(`m${i}`, new Y.Map([['a', 1]]));
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
  const previewed = previewRecord(live, 'g');
  if (shape.valid) {
    expect(previewed, `${shape.name} at ${n}`).toMatchObject({ ok: true });
    expect(previewed.ok && previewed.hunks.length > 0, `${shape.name} at ${n}: the preview has hunks`).toBe(true);
  }
  const hunks: Hunk[] = previewed.ok ? previewed.hunks : hunksOf(live, ops);
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
  let n = Math.floor((SUGGEST_CAPS.recordOpsBytes * 0.8 - (a - 64 * slope)) / slope / 2);
  // Ids grow in bytes with their clocks, so the fit can overshoot; shrink until the doubled record fits.
  while (bytesAt(2 * n) > SUGGEST_CAPS.recordOpsBytes * 0.95) n = Math.floor(n * 0.9);
  return n;
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

/** One op per transaction, as a fork forwards them: `steps` run in turn on a copy of `source` under the leased client. */
function stepsOn(source: Y.Doc, doc: string, steps: number, step: (copy: Y.Doc) => void): RecordOp[] {
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
  copy.clientID = LEASED;
  const ops: RecordOp[] = [];
  copy.on('update', (update: Uint8Array) => ops.push({ doc, update }));
  for (let i = 0; i < steps; i++) copy.transact(() => step(copy));
  copy.destroy();
  return ops;
}

describe('T5.3s many honest delete steps over one long run are not outdated @p:mean-2 @p:R17', () => {
  const LONG = 3000;
  const STEPS = 2500;

  it('backspace held across a long code block: one payload op per character', () => {
    const live = seededBody(`Intro.\n\n\`\`\`js\n${'x'.repeat(LONG)}\n\`\`\`\n`);
    const code = blocks(live).find((x) => x instanceof Y.XmlElement && x.getAttribute('__type') === 'code-block') as Y.XmlElement;
    const key = String(code.getAttribute('__regId'));
    const payload = payloadDocsFor(live).get(key)!;
    expect(payload.getText('payload').toString()).toContain('x'.repeat(LONG));
    const ops = stepsOn(payload, key, STEPS, (copy) => {
      const text = copy.getText('payload');
      text.delete(text.length - 1, 1);
    });
    expect(ops).toHaveLength(STEPS);
    forgeRecord(live, 'g', ops);
    const previewed = previewRecord(live, 'g');
    expect(previewed).toMatchObject({ ok: true });
    expect(previewed.ok && previewed.hunks.some((hunk) => hunk.kind === 'payload' && hunk.id === key)).toBe(true);
  });

  it('a long paragraph struck one character at a time: one delete part per character', () => {
    const live = seededBody(`Intro.\n\n${'w'.repeat(LONG)}\n`);
    const ids = spansOfText(live, 'w'.repeat(LONG)).flatMap((span) => Array.from({ length: span.len }, (_, i) => ({ client: span.client, clock: span.clock + i, len: 1 })));
    expect(ids).toHaveLength(LONG);
    const parts: DeletePart[] = ids.slice(LONG - STEPS).reverse().map((target, i) => ({ id: `part-${i}`, kind: 'delete', targets: [target], quote: 'w' }));
    forgeRecord(live, 'g', [], parts);
    const previewed = previewRecord(live, 'g');
    expect(previewed).toMatchObject({ ok: true });
    expect(previewed.ok && previewed.hunks.length > 0).toBe(true);
  });

  it('two delete parts striking overlapping runs are refused as outdated', () => {
    const live = seededBody(`Intro.\n\n${'w'.repeat(LONG)}\n`);
    const [span] = spansOfText(live, 'w'.repeat(LONG));
    const parts: DeletePart[] = [
      { id: 'part-a', kind: 'delete', targets: [{ client: span.client, clock: span.clock, len: 10 }], quote: 'w'.repeat(10) },
      { id: 'part-b', kind: 'delete', targets: [{ client: span.client, clock: span.clock + 5, len: 10 }], quote: 'w'.repeat(10) },
    ];
    forgeRecord(live, 'g', [], parts);
    expect(previewRecord(live, 'g')).toEqual({ ok: false, reason: 'outdated' });
  });
});
