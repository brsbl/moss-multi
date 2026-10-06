// T5.Ps: suggestions I3 by default-deny (docs/design/suggestions.md §4.4, §14). A census of every Yjs content
// constructor, every root and both parent channels: each struct either shows in the hash-bound preview and lands only
// as shown, or is refused at ingest and at accept with nothing applied. The expected table is restated here, not
// imported, so the census checks the implementation against the design rather than against itself.
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { previewHash, projectDoc, projectionDiff, recordDigest, type RecordMeta, type RecordOp } from '@moss-multi/core/suggest/apply';
import { SuggestIngest } from '../doc/suggest.ts';
import { payloadDocsFor } from '../payload-docs.ts';
import { createRecord, opsOf, partsOf, readMeta, SUGGESTIONS_ORIGIN } from './records.ts';
import { acceptRecord, lexicalBlocks, nodeRegistry, previewRecord } from './review.ts';
import { bodyOf, deterministicIds, EDITOR, seededBody, SUGGESTER } from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

type DocKind = 'body' | 'payload';
type Content = Y.Item['content'];

const TYPES: [string, () => ConstructorParameters<typeof Y.ContentType>[0]][] = [
  ['Y.Array', () => new Y.Array()],
  ['Y.Map', () => new Y.Map()],
  ['Y.Text', () => new Y.Text()],
  ['Y.XmlElement', () => new Y.XmlElement('p')],
  ['Y.XmlFragment', () => new Y.XmlFragment()],
  ['Y.XmlHook', () => new Y.XmlHook('hook')],
  ['Y.XmlText', () => new Y.XmlText()],
];

const CONTENTS: [string, () => Content][] = [
  ['ContentString', () => new Y.ContentString('x')],
  ['ContentAny', () => new Y.ContentAny(['x'])],
  ['ContentJSON', () => new Y.ContentJSON(['x'])],
  ['ContentBinary', () => new Y.ContentBinary(new Uint8Array([1, 2]))],
  ['ContentEmbed', () => new Y.ContentEmbed({ embed: 1 })],
  ['ContentFormat', () => new Y.ContentFormat('bold', true)],
  ...TYPES.map(([name, make]): [string, () => Content] => [`ContentType(${name})`, () => new Y.ContentType(make())]),
  ['ContentDoc', () => new Y.ContentDoc(new Y.Doc({ guid: 'census-subdoc', meta: { hidden: true }, autoLoad: true }))],
  ['ContentDeleted', () => new Y.ContentDeleted(1)],
];

/** The design's channel table (suggestions.md §4.4), at the roots: which constructors each root channel admits. */
const LISTED: Record<DocKind, Record<string, { seq: string[]; key: string[] }>> = {
  body: {
    root: { seq: ['ContentString', 'ContentType(Y.XmlText)', 'ContentType(Y.XmlElement)', 'ContentType(Y.Map)', 'ContentDeleted'], key: ['ContentAny', 'ContentType(Y.Map)', 'ContentDeleted'] },
  },
  payload: {
    payload: { seq: ['ContentString', 'ContentDeleted'], key: [] },
    'payload-map': { seq: [], key: ['ContentAny', 'ContentDeleted'] },
  },
};

const ROOTS = ['root', 'payload', 'payload-map', 'elsewhere'];

/** One V1 update holding exactly `write`'s one struct at clock 0 of `client`, and no deletes. */
function rawUpdate(client: number, write: (encoder: Y.UpdateEncoderV1) => void): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoder.writeClient(client);
  encoding.writeVarUint(encoder.restEncoder, 0);
  write(encoder);
  encoding.writeVarUint(encoder.restEncoder, 0);
  return encoder.toUint8Array();
}

const itemUpdate = (client: number, root: string, sub: string | null, content: Content) =>
  rawUpdate(client, (encoder) => new Y.Item(Y.createID(client, 0), null, null, null, null, root as never, sub, content).write(encoder, 0));

interface Case {
  name: string;
  doc: DocKind;
  update: (client: number) => Uint8Array;
  listed: boolean;
}

const CASES: Case[] = [
  ...(['body', 'payload'] as const).flatMap((doc) =>
    ROOTS.flatMap((root) =>
      ([null, 'k'] as const).flatMap((sub) =>
        CONTENTS.map(([name, make]): Case => ({
          name: `${doc} doc, root "${root}", parentSub ${sub === null ? 'null' : 'set'}: ${name}`,
          doc,
          update: (client) => itemUpdate(client, root, sub, make()),
          listed: (LISTED[doc][root]?.[sub === null ? 'seq' : 'key'] ?? []).includes(name),
        })),
      ),
    ),
  ),
  ...(['body', 'payload'] as const).flatMap((doc): Case[] => [
    { name: `${doc} doc: a GC struct`, doc, update: (client) => rawUpdate(client, (encoder) => new Y.GC(Y.createID(client, 0), 1).write(encoder, 0)), listed: false },
    { name: `${doc} doc: a Skip struct`, doc, update: (client) => rawUpdate(client, (encoder) => new Y.Skip(Y.createID(client, 0), 1).write(encoder, 0)), listed: false },
  ]),
];

/** A record written straight into the map, as if ingest were bypassed: accept must stand alone. */
function forgeRecord(live: Y.Doc, id: string, clients: number[], ops: RecordOp[]): void {
  const meta: RecordMeta = {
    v: 2, id, author: SUGGESTER.id, authorName: SUGGESTER.name, source: 'live', createdAt: 1, updatedAt: 1, status: 'open', clients,
  };
  live.transact(() => {
    createRecord(live, meta);
    opsOf(live, id).push(ops);
    partsOf(live, id).push([]);
  }, SUGGESTIONS_ORIGIN);
}

/** The live code block's payload id. */
function codeKey(live: Y.Doc): string {
  for (const op of live.get('root', Y.XmlText).toDelta() as { insert: unknown }[]) {
    if (op.insert instanceof Y.XmlElement && op.insert.getAttribute('__type') === 'code-block') return String(op.insert.getAttribute('__regId'));
  }
  throw new Error('no code block');
}

/** The note as a reviewer would be shown it, every held payload included. */
const projected = (live: Y.Doc) =>
  projectDoc(live, lexicalBlocks(live), (id) => payloadDocsFor(live).get(id), [...payloadDocsFor(live).docs.keys()]);

interface Outcome {
  ingest: { ok: boolean; reason?: string };
  accept: { ok: boolean; reason?: string };
  hunks: number;
  /** The hash of what accept actually changed, against the hash the preview showed. */
  landed: string | null;
  shown: string | null;
  bodyKept: boolean;
}

/** Ingests `ops` from a fresh lease, then, separately, previews and accepts a forged record of the same ops. */
function run(build: (live: Y.Doc, lease: number) => RecordOp[]): Outcome {
  const live = seededBody();
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
  const [lease] = ingest.lease(SUGGESTER.id);
  const ops = build(live, lease);
  let ingested: Outcome['ingest'] = { ok: true };
  for (const op of ops) {
    const result = ingest.ops(SUGGESTER, 'suggester', 'r1', op);
    if (!result.ok) {
      ingested = result;
      break;
    }
  }
  forgeRecord(live, 'g', [lease], ops);
  const body = bodyOf(live);
  const before = projected(live);
  const preview = previewRecord(live, 'g');
  const digest = recordDigest({ meta: readMeta(live, 'g')!, ops, parts: [] });
  const accepted = acceptRecord(live, 'g', { previewHash: preview.ok ? preview.hash : 'none', digest }, EDITOR);
  const landed = accepted.ok ? previewHash(projectionDiff(before, projected(live))) : null;
  return {
    ingest: ingested,
    accept: accepted,
    hunks: preview.ok ? preview.hunks.length : 0,
    landed,
    shown: preview.ok ? preview.hash : null,
    bodyKept: bodyOf(live) === body,
  };
}

/** Refused at ingest with a typed refusal and at accept, with nothing applied. */
function expectRefused(outcome: Outcome): void {
  expect(outcome.ingest, 'ingest refuses the struct').toEqual({ ok: false, reason: 'channel' });
  expect(outcome.accept.ok, 'accept refuses the struct').toBe(false);
  expect(outcome.bodyKept, 'nothing is applied').toBe(true);
}

describe('T5.Ps census: every struct shows in the preview or is refused @p:mean-2', () => {
  it.each(CASES)('$name', ({ doc, update, listed }) => {
    const outcome = run((live, lease) => [{ doc: doc === 'body' ? 'body' : codeKey(live), update: update(lease) }]);
    if (!listed) {
      expectRefused(outcome);
      return;
    }
    // A listed struct may still fail a later gate (a bare string under the root is not a Lexical tree). When it lands,
    // the preview showed a change and accept changed exactly that.
    if (outcome.accept.ok) {
      expect(outcome.hunks, 'the preview shows the struct').toBeGreaterThan(0);
      expect(outcome.landed, 'accept lands exactly what the preview showed').toBe(outcome.shown);
    } else {
      expect(outcome.bodyKept).toBe(true);
    }
  });
});

describe('T5.Ps the three channels the preview used to miss are refused @p:mean-2', () => {
  /** The updates `write`'s transactions emit on a copy of `source` under `client`, merged, as a fork sends them. */
  const opOn = (source: Y.Doc, client: number, write: (doc: Y.Doc) => void): Uint8Array => {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
    doc.clientID = client;
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    write(doc);
    doc.destroy();
    return Y.mergeUpdates(updates);
  };

  it("sequence items on the 'payload-map' root (parentSub null)", () => {
    expectRefused(run((live, lease) => [{ doc: codeKey(live), update: itemUpdate(lease, 'payload-map', null, new Y.ContentAny(['hidden'])) }]));
  });

  it('a ContentFormat on the note root', () => {
    expectRefused(run((live, lease) => [{ doc: 'body', update: opOn(live, lease, (doc) => doc.get('root', Y.XmlText).format(0, 1, { bold: true })) }]));
  });

  it('a ContentDoc whose meta and options the preview cannot show', () => {
    expectRefused(run((live, lease) => {
      const key = codeKey(live);
      const update = opOn(payloadDocsFor(live).get(key)!, lease, (doc) => doc.getMap('payload-map').set('sub', new Y.Doc({ guid: 'g', meta: { hidden: 1 } })));
      return [{ doc: key, update }];
    }));
  });

  it("an attribute on a payload's text, and a nested Y.Text in its map", () => {
    for (const write of [
      (doc: Y.Doc) => doc.getText('payload').setAttribute('hidden', 'x'),
      (doc: Y.Doc) => doc.getMap('payload-map').set('nested', new Y.Text('n')),
    ]) {
      expectRefused(run((live, lease) => {
        const key = codeKey(live);
        return [{ doc: key, update: opOn(payloadDocsFor(live).get(key)!, lease, write) }];
      }));
    }
  });

  it("a listed channel still lands: an attribute on the note root shows as a note hunk and lands as shown", () => {
    const outcome = run((live, lease) => [{ doc: 'body', update: opOn(live, lease, (doc) => doc.get('root', Y.XmlText).setAttribute('__dir', 'rtl')) }]);
    expect(outcome.ingest).toEqual({ ok: true });
    expect(outcome.accept).toEqual({ ok: true });
    expect(outcome.hunks).toBeGreaterThan(0);
    expect(outcome.landed).toBe(outcome.shown);
  });
});
