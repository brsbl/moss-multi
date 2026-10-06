// T5.Ps: suggestions I3 by default-deny (docs/design/suggestions.md §4.4, §14). A census of every Yjs content
// constructor, every root and both parent channels: each struct either shows in the hash-bound preview and lands only
// as shown, or is refused at ingest and at accept with nothing applied. The expected table is restated here, not
// imported, so the census checks the implementation against the design rather than against itself.
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { deleteUpdate, previewHash, projectDoc, projectionDiff, recordDigest, type RecordMeta, type RecordOp } from '@moss-multi/core/suggest/apply';
import { SuggestIngest } from '../doc/suggest.ts';
import { payloadDocsFor } from '../payload-docs.ts';
import { createRecord, opsOf, partsOf, readMeta, SUGGESTIONS_ORIGIN } from './records.ts';
import { acceptRecord, nodeRegistry, previewRecord } from './review.ts';
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

/** One V1 update holding exactly `write`'s one struct at clock 0 of `client`; `deleted` also deletes that clock. */
function rawUpdate(client: number, write: (encoder: Y.UpdateEncoderV1) => void, deleted = false): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoder.writeClient(client);
  encoding.writeVarUint(encoder.restEncoder, 0);
  write(encoder);
  if (!deleted) encoding.writeVarUint(encoder.restEncoder, 0);
  else for (const n of [1, client, 1, 0, 1]) encoding.writeVarUint(encoder.restEncoder, n);
  return encoder.toUint8Array();
}

/** An item under `parent` (a root's name, or the id of the item holding the parent type), with no origins. */
const itemUpdate = (client: number, parent: string | Y.ID, sub: string | null, content: Content, deleted = content instanceof Y.ContentDeleted) =>
  rawUpdate(client, (encoder) => new Y.Item(Y.createID(client, 0), null, null, null, null, parent as never, sub, content).write(encoder, 0), deleted);

interface Case {
  name: string;
  doc: DocKind;
  /** An editor's write to the live doc before the suggestion, returning the parent the struct names. */
  setup?: (live: Y.Doc) => Y.ID;
  update: (client: number, parent: Y.ID | null) => Uint8Array;
  listed: boolean;
  /** The struct deletes itself, so the preview shows nothing and accept lands nothing. */
  silent?: boolean;
}

const BODY_KEYS = ['ContentAny', 'ContentType(Y.Map)', 'ContentDeleted'];

interface Nest {
  edge: string;
  place: (live: Y.Doc, type: Y.AbstractType<unknown>) => void;
  rows: Record<string, { seq: string[]; key: string[] }>;
}

/** The design's table one level down: a parent type an editor wrote, by the edge it sits on. */
const NESTED: Record<DocKind, Nest> = {
  // The parent sits in the root's sequence: a table edge for XmlText, XmlElement and Map only.
  body: {
    edge: "the root's sequence",
    place: (live, type) => live.get('root', Y.XmlText).insertEmbed(live.get('root', Y.XmlText).length, type as never),
    rows: {
      'Y.XmlText': { seq: LISTED.body.root.seq, key: BODY_KEYS },
      'Y.XmlElement': { seq: [], key: BODY_KEYS },
      'Y.Map': { seq: [], key: BODY_KEYS },
    },
  },
  // The parent sits at a key of 'payload-map', which holds only JSON values: no type there is a table edge.
  payload: {
    edge: "a key of 'payload-map'",
    place: (live, type) => payloadDocsFor(live).get(codeKey(live))!.getMap('payload-map').set('nest', type),
    rows: {},
  },
};

const CASES: Case[] = [
  ...(['body', 'payload'] as const).flatMap((doc) =>
    ROOTS.flatMap((root) =>
      ([null, 'k'] as const).flatMap((sub) =>
        CONTENTS.map(([name, make]): Case => ({
          name: `${doc} doc, root "${root}", parentSub ${sub === null ? 'null' : 'set'}: ${name}`,
          doc,
          update: (client) => itemUpdate(client, root, sub, make()),
          listed: (LISTED[doc][root]?.[sub === null ? 'seq' : 'key'] ?? []).includes(name),
          silent: name === 'ContentDeleted',
        })),
      ),
    ),
  ),
  ...(['body', 'payload'] as const).flatMap((doc) =>
    TYPES.flatMap(([parentName, makeParent]) =>
      ([null, 'k'] as const).flatMap((sub) =>
        CONTENTS.map(([name, make]): Case => ({
          name: `${doc} doc, under a ${parentName} at ${NESTED[doc].edge}, parentSub ${sub === null ? 'null' : 'set'}: ${name}`,
          doc,
          setup: (live) => {
            const parent = makeParent() as unknown as Y.AbstractType<unknown>;
            NESTED[doc].place(live, parent);
            return parent._item!.id;
          },
          update: (client, parent) => itemUpdate(client, parent!, sub, make()),
          listed: (NESTED[doc].rows[parentName]?.[sub === null ? 'seq' : 'key'] ?? []).includes(name),
          silent: name === 'ContentDeleted',
        })),
      ),
    ),
  ),
  ...(['body', 'payload'] as const).flatMap((doc): Case[] => [
    { name: `${doc} doc: a GC struct`, doc, update: (client) => rawUpdate(client, (encoder) => new Y.GC(Y.createID(client, 0), 1).write(encoder, 0)), listed: false },
    {
      name: `${doc} doc: a GC struct the op itself deletes`,
      doc,
      update: (client) => rawUpdate(client, (encoder) => new Y.GC(Y.createID(client, 0), 1).write(encoder, 0), true),
      listed: true,
      silent: true,
    },
    {
      name: `${doc} doc: deleted content the op does not delete`,
      doc,
      update: (client) => itemUpdate(client, doc === 'body' ? 'root' : 'payload', null, new Y.ContentDeleted(1), false),
      listed: false,
    },
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
  projectDoc(live, (id) => payloadDocsFor(live).get(id), [...payloadDocsFor(live).docs.keys()]);

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
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => 'r1' });
  const who = { ...SUGGESTER, role: 'suggester', connection: 'census' };
  const leased = ingest.lease(who, [], 1);
  if (!leased.ok) throw new Error(leased.reason);
  const [{ client: lease }] = leased.leases;
  const ops = build(live, lease);
  let ingested: Outcome['ingest'] = { ok: true };
  for (const op of ops) {
    const result = ingest.ops(who, 'r1', op);
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
  it.each(CASES)('$name', ({ doc, setup, update, listed, silent }) => {
    const outcome = run((live, lease) => {
      const parent = setup?.(live) ?? null;
      return [{ doc: doc === 'body' ? 'body' : codeKey(live), update: update(lease, parent) }];
    });
    if (!listed) {
      expectRefused(outcome);
      return;
    }
    expect(outcome.ingest, 'ingest takes a struct in the table').toEqual({ ok: true });
    // A listed struct may still fail a later gate (a bare string under the root is not a Lexical tree). When it lands,
    // the preview showed the change and accept changed exactly that.
    if (outcome.accept.ok) {
      if (!silent) expect(outcome.hunks, 'the preview shows the struct').toBeGreaterThan(0);
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

  it('a key on a Map an editor nested in an Array: the leaf edge is in the table, an ancestor edge is not', () => {
    // Payload: payload-map holds an Array, which holds a Map.
    expectRefused(run((live, lease) => {
      const key = codeKey(live);
      const held = payloadDocsFor(live).get(key)!;
      held.getMap('payload-map').set('arr', Y.Array.from([new Y.Map()]));
      return [{ doc: key, update: opOn(held, lease, (doc) => (doc.getMap('payload-map').get('arr') as Y.Array<Y.Map<unknown>>).get(0).set('k', 'hidden')) }];
    }));
    // Body: a block's key holds an Array, which holds a Map.
    const firstBlock = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).find((op) => op.insert instanceof Y.XmlText)!.insert as Y.XmlText;
    expectRefused(run((live, lease) => {
      firstBlock(live).setAttribute('arr', Y.Array.from([new Y.Map()]) as never);
      const update = opOn(live, lease, (doc) => (firstBlock(doc).getAttribute('arr') as unknown as Y.Array<Y.Map<unknown>>).get(0).set('k', 'hidden'));
      return [{ doc: 'body', update }];
    }));
  });

  it("a listed channel still lands: an attribute on the note root shows as a note hunk and lands as shown", () => {
    const outcome = run((live, lease) => [{ doc: 'body', update: opOn(live, lease, (doc) => doc.get('root', Y.XmlText).setAttribute('__dir', 'rtl')) }]);
    expect(outcome.ingest).toEqual({ ok: true });
    expect(outcome.accept).toEqual({ ok: true });
    expect(outcome.hunks).toBeGreaterThan(0);
    expect(outcome.landed).toBe(outcome.shown);
  });
});

describe('T5.Ps accept checks every item its transaction deletes, implicit deletions included @p:mean-2', () => {
  const firstBlock = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).find((op) => op.insert instanceof Y.XmlText)!.insert as Y.XmlText;

  /** Refused at accept by G3, with nothing applied; ingest cannot see what the live doc will hold at accept. */
  const expectAcceptRefused = (outcome: Outcome) => {
    expect(outcome.accept, 'accept refuses the deletion').toMatchObject({ ok: false, reason: 'outside-body' });
    expect(outcome.bodyKept, 'nothing is applied').toBe(true);
  };

  it('a delete set naming only an in-table Map holder: the off-table Array under it is deleted recursively', () => {
    expectAcceptRefused(run((live) => {
      const holder = new Y.Map<unknown>();
      firstBlock(live).setAttribute('m', holder as never);
      holder.set('a', Y.Array.from(['secret']));
      const id = holder._item!.id;
      return [{ doc: 'body', update: deleteUpdate([{ client: id.client, clock: id.clock, len: 1 }]) }];
    }));
  });

  it("an in-table value written over a key whose current value is an editor's off-table type", () => {
    expectAcceptRefused(run((live, lease) => {
      firstBlock(live).setAttribute('a', Y.Array.from(['secret']) as never);
      const old = (firstBlock(live).getAttribute('a') as unknown as Y.Array<string>)._item!.id;
      // The overwrite as a forged op: origin is the old value, and the delete set does not name it.
      const update = rawUpdate(lease, (encoder) => new Y.Item(Y.createID(lease, 0), null, old, null, null, null, 'a', new Y.ContentAny(['plain'])).write(encoder, 0));
      return [{ doc: 'body', update }];
    }));
  });
});
