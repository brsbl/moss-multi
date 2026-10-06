// T5.3s: a forged record whose field names, node types, map keys or payload ids are Object.prototype names
// (__proto__, constructor, toString, hasOwnProperty, valueOf, prototype) is read like any other: the preview never
// throws, the card shows a row naming it, and the preview hash covers it. Lookups keyed by record-controlled names use
// Maps or own-property checks, never `in` or plain indexing on an object literal.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { previewHash, type RecordOp } from '@moss-multi/core/suggest/apply';
import { describeHunks, type ReviewRow } from '@moss-multi/core/suggest/describe';
import { SuggestIngest } from '../doc/suggest.ts';
import { payloadDocsFor } from '../payload-docs.ts';
import { nodeRegistry, previewRecord } from './review.ts';
import { deterministicIds, forgeRecord, hunksOf, opOn, seededBody, SUGGESTER } from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'] as const;

const GATES = ['not-open', 'unresolvable', 'foreign-client', 'outside-body', 'payload-alias', 'outdated', 'changed', 'broken', 'doc-cap'];

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
const blocks = (doc: Y.Doc) => (root(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert);
const paragraph = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlText) as Y.XmlText;
const textMap = (doc: Y.Doc) => (paragraph(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.Map) as Y.Map<unknown>;
const decorator = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlElement && x.getAttribute('__type') === 'code-block') as Y.XmlElement;
const codeKey = (doc: Y.Doc) => String(decorator(doc).getAttribute('__regId'));

const TEXT_FIELDS: [string, unknown][] = [['__type', 'text'], ['__format', 0], ['__style', ''], ['__mode', 'normal'], ['__detail', 0]];

/** A new paragraph after the first block: `fields` on it, then a text node holding `text`. */
function newBlock(doc: Y.Doc, fields: [string, unknown][], text: string, textFields: [string, unknown][] = TEXT_FIELDS): void {
  const block = new Y.XmlText();
  root(doc).insertEmbed(1, block);
  for (const [key, value] of fields) block.setAttribute(key, value as never);
  block.insertEmbed(0, new Y.Map(textFields));
  block.insert(1, text);
}

/** A new text node at the end of the first paragraph. */
function newTextNode(doc: Y.Doc, fields: [string, unknown][], text: string): void {
  const at = paragraph(doc).length;
  paragraph(doc).insertEmbed(at, new Y.Map(fields));
  paragraph(doc).insert(at + 1, text);
}

/** How the card names a stored key: `__indent` reads `indent`; any other key is quoted. */
const fieldLabel = (name: string) => (name.startsWith('__') ? name.slice(2) : JSON.stringify(name));

interface Case {
  position: string;
  /** Writes the forged record's change; `variant` 0 and 1 differ only in the forged value. */
  write: (name: string, variant: 0 | 1) => (doc: Y.Doc) => void;
  on?: 'body' | 'payload';
  /** What a row must show: the field as the card names it, or the node type. */
  needle: (name: string) => string;
}

const value = (variant: 0 | 1) => (variant ? 'forged-b' : 'forged-a');

const CASES: Case[] = [
  { position: 'an element field', write: (name, v) => (doc) => paragraph(doc).setAttribute(name, value(v)), needle: fieldLabel },
  { position: 'a decorator field', write: (name, v) => (doc) => decorator(doc).setAttribute(name, value(v)), needle: fieldLabel },
  { position: 'a text node map key', write: (name, v) => (doc) => textMap(doc).set(name, value(v)), needle: fieldLabel },
  { position: 'a note setting', write: (name, v) => (doc) => root(doc).setAttribute(name, value(v)), needle: fieldLabel },
  { position: 'a nested map key', write: (name, v) => (doc) => paragraph(doc).setAttribute('__extra', new Y.Map([[name, value(v)]]) as never), needle: fieldLabel },
  { position: 'a payload map key', write: (name, v) => (doc) => doc.getMap('payload-map').set(name, value(v)), on: 'payload', needle: fieldLabel },
  { position: 'a field of a new block', write: (name, v) => (doc) => newBlock(doc, [['__type', 'paragraph'], [name, value(v)]], 'forged text'), needle: fieldLabel },
  { position: 'a field of a new text node', write: (name, v) => (doc) => newTextNode(doc, [...TEXT_FIELDS, [name, value(v)]], 'forged text'), needle: fieldLabel },
  { position: "a new block's node type", write: (name, v) => (doc) => newBlock(doc, [['__type', name]], value(v)), needle: (name) => name },
  { position: "a new text node's node type", write: (name, v) => (doc) => newTextNode(doc, [['__type', name], ['__format', 0]], value(v)), needle: (name) => name },
  {
    position: "a new decorator's node type",
    write: (name, v) => (doc) => {
      const element = new Y.XmlElement('decorator');
      root(doc).insertEmbed(1, element);
      element.setAttribute('__type', name);
      element.setAttribute('__forged', value(v));
    },
    needle: (name) => name,
  },
];

/** The op `write` makes, on the body or on the code block's payload doc. */
function opFor(live: Y.Doc, write: (doc: Y.Doc) => void, on: 'body' | 'payload' = 'body'): RecordOp {
  return on === 'body' ? opOn(live, 'body', write) : opOn(payloadDocsFor(live).get(codeKey(live))!, codeKey(live), write);
}

const shown = (rows: ReviewRow[]) => rows.map((row) => `${row.kind} ${row.text} ${row.note ?? ''}`).join('\n');
const names = (rows: ReviewRow[], needle: string) => rows.some((row) => `${row.text} ${row.note ?? ''}`.includes(needle));

describe('T5.3s forged records named like Object.prototype members @p:mean-2 @p:R17', () => {
  const table = CASES.flatMap((c) => NAMES.map((name) => ({ ...c, name })));

  it.each(table)('$position named $name: the card shows a row naming it, and the hash covers it', ({ write, on, needle, name }) => {
    const live = seededBody();
    const hunks = [0, 1].map((v) => hunksOf(live, [opFor(live, write(name, v as 0 | 1), on)]));
    for (const listed of hunks) {
      let rows: ReviewRow[] = [];
      expect(() => {
        rows = describeHunks(listed);
      }).not.toThrow();
      expect(names(rows, needle(name)), shown(rows)).toBe(true);
      expect(previewHash(listed), 'the change is in the hash').not.toBe(previewHash([]));
    }
    expect(previewHash(hunks[0]), 'the forged value is in the hash').not.toBe(previewHash(hunks[1]));
  });

  it.each(table)('$position named $name: the DocDO preview never throws, and a preview it gives reads the same', ({ write, on, needle, name }) => {
    const hashes: string[] = [];
    for (const v of [0, 1] as const) {
      const live = seededBody();
      forgeRecord(live, 'g', [opFor(live, write(name, v), on)]);
      let preview: ReturnType<typeof previewRecord> | null = null;
      expect(() => {
        preview = previewRecord(live, 'g');
      }).not.toThrow();
      const result = preview as unknown as ReturnType<typeof previewRecord>;
      if (!result.ok) {
        expect(GATES, `refused with a gate reason, not a crash: ${result.reason}`).toContain(result.reason);
        continue;
      }
      const rows = describeHunks(result.hunks);
      expect(names(rows, needle(name)), shown(rows)).toBe(true);
      hashes.push(result.hash);
    }
    if (hashes.length === 2) expect(hashes[0]).not.toBe(hashes[1]);
  });

  it.each(NAMES)('a payload doc id %s: preview and card never throw, and the hash covers the payload', (name) => {
    const live = seededBody();
    const payloadOp = (text: string): RecordOp => {
      const doc = new Y.Doc();
      doc.clientID = 0x7fff1234;
      const updates: Uint8Array[] = [];
      doc.on('update', (update: Uint8Array) => updates.push(update));
      doc.getText('payload').insert(0, text);
      return { doc: name, update: Y.mergeUpdates(updates) };
    };
    const [a, b] = ['forged-a', 'forged-b'].map((text) => hunksOf(live, [payloadOp(text)]));
    expect(a.some((hunk) => hunk.kind === 'payload' && hunk.id === name), JSON.stringify(a)).toBe(true);
    expect(previewHash(a)).not.toBe(previewHash(b));
    const rows = describeHunks(a);
    expect(rows.some((row) => row.detail.startsWith(`payload ${name} `) && row.text.includes('forged-a')), shown(rows)).toBe(true);
    forgeRecord(live, 'g', [payloadOp('forged-a')]);
    expect(() => previewRecord(live, 'g')).not.toThrow();
  });

  it.each(NAMES)("ingest keeps a lease's clock in a payload doc named %s: a first write past clock 0 is a gap", (name) => {
    const live = seededBody();
    const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
    const who = { ...SUGGESTER, role: 'suggester', connection: 'c-names' };
    const leased = ingest.lease(who, [], 1);
    if (!leased.ok) throw new Error(leased.reason);
    const [{ client, record }] = leased.leases;
    const doc = new Y.Doc();
    doc.clientID = client;
    doc.getText('payload').insert(0, 'early');
    const sv = Y.encodeStateVector(doc);
    doc.getText('payload').insert(5, ' late');
    const gapped = Y.encodeStateAsUpdate(doc, sv);
    expect(Y.parseUpdateMeta(gapped).from.get(client)).toBe(5);
    expect(ingest.ops(who, record, { doc: name, update: gapped })).toEqual({ ok: false, reason: 'clock-gap' });
    // From clock 0 it lands, and the next frame must start where it ended.
    expect(ingest.ops(who, record, { doc: name, update: Y.encodeStateAsUpdate(doc) })).toMatchObject({ ok: true });
    expect(ingest.ops(who, record, { doc: name, update: gapped })).toEqual({ ok: false, reason: 'clock-overlap' });
  });
});
