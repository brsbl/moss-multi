// T5.3: the suggestion card is a total, lossless reading of the hunks the preview hash covers (docs/design/suggestions.md
// §4.4). A census over every channel-table entry and field kind: a record changing only that field gets a row naming
// it. Text rows follow Yjs item identity, so a word replacement reads as the word removed and the word added. And the
// rows are injective over hunk lists: two previews with different hashes never read the same.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { CHANNELS, canonical, previewHash, type Hunk, type RecordMeta, type RecordOp } from '@moss-multi/core/suggest/apply';
import { describeHunks, type ReviewRow } from '@moss-multi/core/suggest/describe';
import { SuggestIngest } from '../doc/suggest.ts';
import { payloadDocsFor } from '../payload-docs.ts';
import { ForkShim } from './fork-shim.ts';
import { createRecord, opsOf, partsOf, writeSuggestions } from './records.ts';
import { nodeRegistry, previewRecord } from './review.ts';
import { CENSUS, codeBlock, deterministicIds, insertBlock, seededBody, select, spansOfText, SUGGESTER } from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

const LEASED = 0x7fff1234;

function forgeRecord(live: Y.Doc, id: string, ops: RecordOp[]): void {
  const meta: RecordMeta = {
    v: 2, id, author: SUGGESTER.id, authorName: SUGGESTER.name, source: 'live', createdAt: 1, updatedAt: 1, status: 'open', clients: [LEASED],
  };
  writeSuggestions(live, () => {
    createRecord(live, meta);
    opsOf(live, id).push(ops);
    partsOf(live, id).push([]);
  });
}

/** One op holding what `write` does to a copy of `source` under the leased client. */
function opOn(source: Y.Doc, doc: string, write: (copy: Y.Doc) => void): RecordOp {
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
  copy.clientID = LEASED;
  const updates: Uint8Array[] = [];
  copy.on('update', (update: Uint8Array) => updates.push(update));
  write(copy);
  copy.destroy();
  return { doc, update: Y.mergeUpdates(updates) };
}

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
const blocks = (doc: Y.Doc) => (root(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert);
const paragraph = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlText) as Y.XmlText;
const textMap = (doc: Y.Doc) => (paragraph(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.Map) as Y.Map<unknown>;
const decorator = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlElement && x.getAttribute('__type') === 'code-block') as Y.XmlElement;
const indented = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlText && x.toString().includes('Indented')) as Y.XmlText;
const codeKey = (doc: Y.Doc) => String(decorator(doc).getAttribute('__regId'));

/** Rows of a forged record's preview on a fresh seeded note: a body op, or a payload op on the code block's payload. */
function forgedRows(write: (doc: Y.Doc) => void, on: 'body' | 'payload' = 'body', prepare?: (live: Y.Doc) => void): { rows: ReviewRow[]; hash: string; hunks: Hunk[] } {
  const live = seededBody();
  prepare?.(live);
  const op = on === 'body' ? opOn(live, 'body', write) : opOn(payloadDocsFor(live).get(codeKey(live))!, codeKey(live), write);
  forgeRecord(live, 'g', [op]);
  const preview = previewRecord(live, 'g');
  if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
  return { rows: describeHunks(preview.hunks), hash: preview.hash, hunks: preview.hunks };
}

/** Rows of a record a suggester's fork makes with `steps`, with `deletes` proposed as delete parts first. */
function suggestedRows(steps: (() => void)[], deletes: string[] = []): ReviewRow[] {
  const live = seededBody();
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => 'r1' });
  const who = { ...SUGGESTER, role: 'suggester', connection: 'describe' };
  const leased = ingest.lease(who, [], 1);
  if (!leased.ok) throw new Error(leased.reason);
  deletes.forEach((text, n) => {
    const result = ingest.delete(who, 'r1', { id: `d${n}`, targets: spansOfText(live, text) });
    if (!result.ok) throw new Error(`delete refused: ${result.reason}`);
  });
  const fork = new ForkShim(live, leased.leases[0].client);
  try {
    for (const step of steps) fork.act(step);
    for (const op of fork.sent) {
      const result = ingest.ops(who, 'r1', op);
      if (!result.ok) throw new Error(`ingest refused: ${result.reason}`);
    }
  } finally {
    fork.dispose();
  }
  const preview = previewRecord(live, 'r1');
  if (!preview.ok) throw new Error(preview.reason);
  return describeHunks(preview.hunks);
}

const visible = (rows: ReviewRow[]) => rows.map((row) => [row.kind, row.text, row.note ?? '']);
const shown = (rows: ReviewRow[]) => rows.map((row) => `${row.kind} ${row.text} ${row.note ?? ''}`).join('\n');
/** A row whose visible text and note hold every needle. */
const named = (rows: ReviewRow[], needles: string[], kind?: ReviewRow['kind']) =>
  rows.some((row) => (!kind || row.kind === kind) && needles.every((needle) => `${row.text} ${row.note ?? ''}`.includes(needle)));

type Channel = `${'body' | 'payload'}/${string}/${string}/${'seq' | 'key'}`;

interface CensusCase {
  name: string;
  channel: Channel;
  content: string;
  rows: () => ReviewRow[];
  needles: string[];
  kind?: ReviewRow['kind'];
}

const keyCase = (
  name: string, channel: Channel, content: string, write: (doc: Y.Doc) => void, needles: string[], on: 'body' | 'payload' = 'body', prepare?: (live: Y.Doc) => void,
): CensusCase => ({ name, channel, content, rows: () => forgedRows(write, on, prepare).rows, needles, kind: 'change' });

const CASES: CensusCase[] = [
  // An element's keys: Lexical's own fields, stored ones it does not export (one colliding with a child's field), a
  // key outside Lexical's naming, a nested map, and a removal.
  keyCase('element alignment', 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('__format', 2 as never), ['format', 'center']),
  keyCase('element indent', 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('__indent', 3 as never), ['indent', '3']),
  keyCase('element direction', 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('__dir', 'rtl'), ['direction', 'rtl']),
  keyCase('element text format', 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('__textFormat', 1 as never), ['textFormat', 'bold']),
  keyCase('element text style', 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('__textStyle', 'color: red'), ['textStyle', 'color: red']),
  keyCase("a stored key named like a child's field", 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('__text', 'stored-secret'), ['text', 'stored-secret']),
  keyCase('a stored style', 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('__style', 'stored-style'), ['style', 'stored-style']),
  keyCase('a stored key Lexical does not export', 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('__hidden', 'stored-secret'), ['hidden', 'stored-secret']),
  keyCase('a key outside Lexical naming', 'body/root/XmlText/key', 'Any', (doc) => paragraph(doc).setAttribute('plain', 'raw-value'), ['"plain"', 'raw-value']),
  keyCase('a nested map on an element', 'body/root/XmlText/key', 'Type:Map', (doc) => paragraph(doc).setAttribute('__extra', new Y.Map([['k', 'deep-value']]) as never), ['extra', 'deep-value']),
  keyCase('a removed element field', 'body/root/XmlText/key', 'Deleted', (doc) => indented(doc).removeAttribute('__indent'), ['indent', '1', 'none']),
  keyCase('a note setting', 'body/root/XmlText/key', 'Any', (doc) => root(doc).setAttribute('__dir', 'rtl'), ['direction', 'rtl']),
  keyCase('a stored note setting', 'body/root/XmlText/key', 'Any', (doc) => root(doc).setAttribute('__hidden', 'note-secret'), ['hidden', 'note-secret']),
  // A decorator's keys.
  keyCase('a decorator field', 'body/root/XmlElement/key', 'Any', (doc) => decorator(doc).setAttribute('__hidden', 'deco-secret'), ['code-block', 'hidden', 'deco-secret']),
  keyCase('a decorator format', 'body/root/XmlElement/key', 'Any', (doc) => decorator(doc).setAttribute('__format', 3 as never), ['format', 'right']),
  keyCase('a removed decorator field', 'body/root/XmlElement/key', 'Deleted', (doc) => decorator(doc).removeAttribute('__language'), ['code-block', 'language', 'javascript', 'none']),
  keyCase('a nested map on a decorator', 'body/root/XmlElement/key', 'Type:Map', (doc) => decorator(doc).setAttribute('__extra', new Y.Map([['k', 'deco-deep']]) as never), ['extra', 'deco-deep']),
  // A text node's keys.
  keyCase('text format', 'body/root/Map/key', 'Any', (doc) => textMap(doc).set('__format', 1), ['world', 'format', 'bold']),
  keyCase('text style', 'body/root/Map/key', 'Any', (doc) => textMap(doc).set('__style', 'color: blue'), ['style', 'color: blue']),
  keyCase('text mode', 'body/root/Map/key', 'Any', (doc) => textMap(doc).set('__mode', 'token'), ['mode', 'token']),
  keyCase('text detail', 'body/root/Map/key', 'Any', (doc) => textMap(doc).set('__detail', 1), ['detail', '1']),
  keyCase("a text node's stored text", 'body/root/Map/key', 'Any', (doc) => textMap(doc).set('__text', 'stored-secret'), ['text', 'stored-secret']),
  keyCase("a text node's stored key", 'body/root/Map/key', 'Any', (doc) => textMap(doc).set('__hidden', 'map-secret'), ['hidden', 'map-secret']),
  keyCase('a nested map on a text node', 'body/root/Map/key', 'Type:Map', (doc) => textMap(doc).set('__extra', new Y.Map([['k', 'map-deep']])), ['extra', 'map-deep']),
  keyCase('a removed text field', 'body/root/Map/key', 'Deleted', (doc) => textMap(doc).delete('__style'), ['style', 'none']),
  // A compound payload's fields.
  keyCase('a payload field', 'payload/payload-map/Map/key', 'Any', (doc) => doc.getMap('payload-map').set('lang', 'python'), ['lang', 'python'], 'payload'),
  keyCase('a removed payload field', 'payload/payload-map/Map/key', 'Deleted', (doc) => doc.getMap('payload-map').delete('lang'), ['lang', 'ruby', 'none'], 'payload', (live) => {
    payloadDocsFor(live).get(codeKey(live))!.getMap('payload-map').set('lang', 'ruby');
  }),
  // Sequences: text, a new element, a new decorator, a new text-node map, a line break, and removals.
  { name: 'inserted text', channel: 'body/root/XmlText/seq', content: 'String', rows: () => suggestedRows([() => select('Hello', 6).insertText('brave ')]), needles: ['brave'], kind: 'insert' },
  { name: 'removed text', channel: 'body/root/XmlText/seq', content: 'Deleted', rows: () => suggestedRows([], ['cat']), needles: ['cat'], kind: 'delete' },
  { name: 'a new block', channel: 'body/root/XmlText/seq', content: 'Type:XmlText', rows: () => suggestedRows([insertBlock('Fresh block here.')]), needles: ['Fresh block here.', 'paragraph'], kind: 'insert' },
  { name: 'a new decorator', channel: 'body/root/XmlText/seq', content: 'Type:XmlElement', rows: () => suggestedRows([insertBlock('```js\nnew code\n```')]), needles: ['code-block'], kind: 'insert' },
  { name: 'a new formatted text node', channel: 'body/root/XmlText/seq', content: 'Type:Map', rows: () => suggestedRows([() => select('Hello', 6, 11).formatText('bold')]), needles: ['world', 'bold'], kind: 'insert' },
  { name: 'a new line break', channel: 'body/root/XmlText/seq', content: 'Type:Map', rows: () => suggestedRows([() => select('Hello', 5).insertLineBreak()]), needles: ['linebreak'], kind: 'insert' },
  { name: 'payload text added', channel: 'payload/payload/Text/seq', content: 'String', rows: () => suggestedRows([() => codeBlock().setCode('seed!')]), needles: ['!', 'block content'], kind: 'insert' },
  { name: 'payload text removed', channel: 'payload/payload/Text/seq', content: 'Deleted', rows: () => suggestedRows([() => codeBlock().setCode('see')]), needles: ['d', 'block content'], kind: 'delete' },
];

describe('T5.3 census: every channel and field a record can change has a row naming it @p:mean-2 @p:R17', () => {
  it('the census covers every channel-table entry and each content it lists', () => {
    const covered = new Set(CASES.map((c) => `${c.channel}:${c.content}`));
    for (const channel of CHANNELS) {
      for (const content of channel.content) {
        expect(covered, `${channel.doc}/${channel.root}/${channel.parent}/${channel.sub}: ${content}`).toContain(`${channel.doc}/${channel.root}/${channel.parent}/${channel.sub}:${content}`);
      }
    }
  });

  it.each(CASES)('$name ($channel, $content)', ({ rows, needles, kind }) => {
    const listed = rows();
    expect(named(listed, needles, kind), shown(listed)).toBe(true);
  });

  it.each(CENSUS.filter((op) => !op.steps.includes('undo')).map((op) => [op.name, op] as const))('every hunk of "%s" has a row', (_name, op) => {
    const live = seededBody();
    const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => 'r1' });
    const who = { ...SUGGESTER, role: 'suggester', connection: 'describe' };
    const leased = ingest.lease(who, [], 1);
    if (!leased.ok) throw new Error(leased.reason);
    const fork = new ForkShim(live, leased.leases[0].client);
    try {
      for (const step of op.steps) if (step !== 'undo') fork.act(step);
      for (const sent of fork.sent) expect(ingest.ops(who, 'r1', sent)).toMatchObject({ ok: true });
    } finally {
      fork.dispose();
    }
    const preview = previewRecord(live, 'r1');
    if (!preview.ok) throw new Error(preview.reason);
    const rows = describeHunks(preview.hunks);
    for (const hunk of preview.hunks) {
      expect(rows.some((row) => row.detail.startsWith(`${hunk.kind} ${hunk.id} ${hunk.op}`)), `${hunk.kind} ${hunk.id}\n${shown(rows)}`).toBe(true);
    }
    for (const row of rows) expect(`${row.text}${row.note ?? ''}`, shown(rows)).not.toBe('');
  });
});

describe('T5.3 text rows follow Yjs item identity @p:mean-2 @p:R17', () => {
  it('a word replaced in one op reads as the word removed and the word added', () => {
    const { rows } = forgedRows((doc) => {
      paragraph(doc).delete(7, 5);
      paragraph(doc).insert(7, 'legacy');
    });
    expect(visible(rows), shown(rows)).toEqual([
      ['delete', 'world', ''],
      ['insert', 'legacy', ''],
    ]);
  });

  it("a suggester's word replacement (a delete part and typed text) reads '− old' '+ new'", () => {
    const rows = suggestedRows([() => select('Hello', 11).insertText('legacy')], ['world']);
    expect(rows.filter((row) => row.kind === 'delete').map((row) => row.text), shown(rows)).toEqual(['world']);
    expect(rows.filter((row) => row.kind === 'insert').map((row) => row.text), shown(rows)).toEqual(['legacy']);
  });
});

describe('T5.3 rows read in document order @p:mean-2 @p:R17', () => {
  it('new blocks read top to bottom after the block they follow, whatever their ids sort as', () => {
    const block = (text: string) => ({ type: 'XmlText', seq: [{ id: '9:0', s: text }], keys: [['__type', { Any: ['paragraph'] }]] });
    // Hash order (by id) is 5, 1, 3; the document reads changed 7, then 3, 1, 5 by their anchors.
    const listed: Hunk[] = [
      { kind: 'block', id: '1:5', op: 'added', after: block('Line 2'), at: '1:3' },
      { kind: 'block', id: '2:1', op: 'added', after: block('Line 3'), at: '1:5' },
      { kind: 'block', id: '1:3', op: 'added', after: block('Line 1'), at: '1:7' },
      { kind: 'block', id: '1:7', op: 'changed', before: block('old'), after: { ...block('new'), seq: [{ id: '9:9', s: 'new' }] } },
    ];
    const rows = describeHunks([...listed].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(rows.map((row) => row.text), shown(rows)).toEqual(['old', 'new', 'Line 1', 'Line 2', 'Line 3']);
  });
});

/** A small seeded generator, so a failure replays. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('T5.3 the rows are injective over hunk lists @p:mean-2 @p:R17', () => {
  const VALUES: unknown[] = ['x', 'x ', ' x', 'null', null, '', 'none', 1, '1', 2, true, 'true', false, 'bold', 'plain', { a: 1 }, '{"a":1}', [1], '[1]'];

  it.each([
    ['a stored key on an element', (doc: Y.Doc, value: unknown) => paragraph(doc).setAttribute('__hidden', value as never)],
    ["a text node's format", (doc: Y.Doc, value: unknown) => textMap(doc).set('__format', value)],
    ['a note setting', (doc: Y.Doc, value: unknown) => root(doc).setAttribute('__hidden', value as never)],
  ] as const)('%s: two values with different hashes never read the same, even without the detail', (_name, write) => {
    const seen = new Map<string, string>();
    for (const value of VALUES) {
      const { rows, hash } = forgedRows((doc) => write(doc, value));
      const key = canonical(visible(rows));
      if (seen.has(key)) expect(seen.get(key), `${canonical(value)} reads as another value: ${key}`).toBe(hash);
      seen.set(key, hash);
    }
  });

  it('mutating any value in a preview changes its rows exactly when it changes the hash', () => {
    const base = suggestedRowsHunks();
    const rand = prng(53);
    const original = canonical(describeHunks(base));
    const byRows = new Map<string, string>([[original, previewHash(base)]]);
    for (let n = 0; n < 300; n++) {
      const hunks = JSON.parse(JSON.stringify(base)) as Hunk[];
      const leaves: { holder: Record<string, unknown> | unknown[]; key: string | number }[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) value.forEach((item, i) => (item && typeof item === 'object' ? walk(item) : leaves.push({ holder: value, key: i })));
        else if (value && typeof value === 'object') {
          for (const [key, item] of Object.entries(value)) {
            if (item && typeof item === 'object') walk(item);
            else leaves.push({ holder: value as Record<string, unknown>, key });
          }
        }
      };
      walk(hunks);
      const leaf = leaves[Math.floor(rand() * leaves.length)];
      const was = (leaf.holder as Record<string | number, unknown>)[leaf.key];
      const choices: unknown[] = typeof was === 'string' ? [`${was}x`, was.slice(1), was.toUpperCase(), 'x'] : typeof was === 'number' ? [was + 1, was - 1, 0] : [true, false, null, 'x'];
      (leaf.holder as Record<string | number, unknown>)[leaf.key] = choices[Math.floor(rand() * choices.length)];
      const hash = previewHash(hunks);
      const rows = canonical(describeHunks(hunks));
      if (byRows.has(rows)) expect(byRows.get(rows), `mutation ${n} at ${String(leaf.key)} reads as another hunk list`).toBe(hash);
      byRows.set(rows, hash);
    }
  });
});

/** A preview with text, formatting, a new block, a key change and a payload edit. */
function suggestedRowsHunks(): Hunk[] {
  const live = seededBody();
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => 'r1' });
  const who = { ...SUGGESTER, role: 'suggester', connection: 'describe' };
  const leased = ingest.lease(who, [], 1);
  if (!leased.ok) throw new Error(leased.reason);
  expect(ingest.delete(who, 'r1', { id: 'd0', targets: spansOfText(live, 'cat') })).toMatchObject({ ok: true });
  const fork = new ForkShim(live, leased.leases[0].client);
  try {
    for (const step of [
      () => select('Hello', 6).insertText('brave '),
      () => select('Go to ', 0, 2).formatText('bold'),
      insertBlock('- [x] done item\n- [ ] open item'),
      () => codeBlock().setCode('seed!'),
    ]) fork.act(step);
    for (const op of fork.sent) expect(ingest.ops(who, 'r1', op)).toMatchObject({ ok: true });
  } finally {
    fork.dispose();
  }
  const preview = previewRecord(live, 'r1');
  if (!preview.ok) throw new Error(preview.reason);
  return preview.hunks;
}
