// T5.0 spike, tests 4–7 (docs/design/suggestions.md §9): reject and withdraw never write the body or a payload;
// forged records meet each accept gate with nothing applied; a record whose context an editor changed is outdated; the
// projection a reviewer sees covers text, attributes and payload docs, and binds the accept (T5.P).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import {
  applyRecord, canonical, hydrate, previewHash, projectDoc, recordDigest, type DeletePart, type RecordMeta, type RecordOp,
} from '@moss-multi/core/suggest/apply';
import { SuggestIngest } from '../doc/suggest.ts';
import { payloadDocsFor } from '../payload-docs.ts';
import { ForkShim } from './fork-shim.ts';
import { createRecord, opsOf, partsOf, readMeta, readRecord, writeSuggestions } from './records.ts';
import { acceptRecord, exportWorkingMarkdown, nodeRegistry, previewRecord, rejectRecord, reviewPreview, withdrawRecord } from './review.ts';
import {
  bodyOf, changedRoots, codeBlock, deterministicIds, editorEdits, EDITOR, exported, insertBlock, listItem, NOTE_ID, OTHER_SUGGESTER, payloadsInOrder,
  select, seededBody, spansOfText, SUGGESTER,
} from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

function setup() {
  const live = seededBody();
  /** The record ids the next leases are minted with, so tests can name them. */
  const named: string[] = [];
  let minted = 0;
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => named.shift() ?? `minted-${(minted += 1)}` });
  const forks: ForkShim[] = [];
  const actor = (who: typeof SUGGESTER) => ({ ...who, role: 'suggester', connection: `connection-${who.id}-${forks.length}` });
  /** A lease for `who`, minted with record id `id` unless that record exists already. */
  const lease = (id: string, who = SUGGESTER) => {
    if (!readMeta(live, id)) named.push(id);
    const leased = ingest.lease(actor(who), [], 1);
    if (!leased.ok) throw new Error(`lease refused: ${leased.reason}`);
    return { who: actor(who), client: leased.leases[0].client };
  };
  /** A suggester's fork makes `steps` into record `id`. */
  const suggest = (id: string, steps: (() => void)[], who = SUGGESTER) => {
    const leased = lease(id, who);
    const fork = new ForkShim(live, leased.client);
    forks.push(fork);
    for (const step of steps) fork.act(step);
    for (const op of fork.sent) {
      const result = ingest.ops(leased.who, id, op);
      if (!result.ok) throw new Error(`ingest refused: ${result.reason}`);
    }
    return fork;
  };
  /** A delete part into record `id`, as `who`. */
  const proposeDelete = (id: string, part: { id: string; targets: { client: number; clock: number; len: number }[] }, who = SUGGESTER) =>
    ingest.delete(lease(id, who).who, id, part);
  const accept = (id: string, hash?: string) => {
    const record = readRecord(live, id)!;
    const preview = previewRecord(live, id);
    return acceptRecord(live, id, { previewHash: hash ?? (preview.ok ? preview.hash : 'none'), digest: recordDigest(record) }, EDITOR);
  };
  return { live, ingest, suggest, proposeDelete, accept, dispose: () => forks.forEach((fork) => fork.dispose()) };
}

const LEASED = 0x7fff1234;

/** A record written straight into the map, as if ingest were bypassed: the gates must stand alone. */
function forgeRecord(live: Y.Doc, id: string, clients: number[], ops: RecordOp[], parts: DeletePart[] = []): void {
  const meta: RecordMeta = {
    v: 2, id, author: SUGGESTER.id, authorName: SUGGESTER.name, source: 'live', createdAt: 1, updatedAt: 1, status: 'open', clients,
  };
  writeSuggestions(live, () => {
    createRecord(live, meta);
    opsOf(live, id).push(ops);
    partsOf(live, id).push(parts);
  });
}

/** The updates `write`'s transactions emit on a copy of `live` under `client`, as a fork's provider sends them. */
function updatesOf(live: Y.Doc, write: (doc: Y.Doc) => void, client = LEASED): Uint8Array[] {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = client;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  write(doc);
  doc.destroy();
  return updates;
}

const forged = (live: Y.Doc, write: (doc: Y.Doc) => void, client = LEASED): RecordOp => ({ doc: 'body', update: Y.mergeUpdates(updatesOf(live, write, client)) });
const bodyOps = (updates: Uint8Array[]): RecordOp[] => updates.map((update) => ({ doc: 'body', update }));

/** The updates `write`'s transactions emit on a copy of payload `id` (an empty doc for a new id) under `client`. */
function payloadUpdatesOf(live: Y.Doc, id: string, write: (text: Y.Text, doc: Y.Doc) => void, client = LEASED): RecordOp[] {
  const doc = new Y.Doc({ gc: false });
  const held = payloadDocsFor(live).get(id);
  if (held) Y.applyUpdate(doc, Y.encodeStateAsUpdate(held));
  doc.clientID = client;
  const ops: RecordOp[] = [];
  doc.on('update', (update: Uint8Array) => ops.push({ doc: id, update }));
  write(doc.getText('payload'), doc);
  doc.destroy();
  return ops;
}

const payloadOp = (live: Y.Doc, id: string, write: (text: Y.Text, doc: Y.Doc) => void, client = LEASED): RecordOp =>
  ({ doc: id, update: Y.mergeUpdates(payloadUpdatesOf(live, id, write, client).map((op) => op.update)) });

/** The payload id the live code block names, after an editor deleted that block: a withheld payload. */
function withheldCode(live: Y.Doc): string {
  const { key } = codeDecorator(live);
  editorEdits(live, () => codeBlock().remove());
  expect(payloadDocsFor(live).has(key), 'the payload is kept, unnamed').toBe(true);
  return key;
}

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);

function block(type: string, attrs: Record<string, unknown> = {}): Y.XmlText {
  const text = new Y.XmlText();
  text.setAttribute('__type', type);
  for (const [key, value] of Object.entries(attrs)) text.setAttribute(key, value as string);
  return text;
}

/** The live top-level code-block decorator's element and its payload id. */
function codeDecorator(doc: Y.Doc): { element: Y.XmlElement; key: string } {
  for (const op of root(doc).toDelta() as { insert: unknown }[]) {
    if (op.insert instanceof Y.XmlElement && op.insert.getAttribute('__type') === 'code-block') {
      return { element: op.insert, key: String(op.insert.getAttribute('__regId')) };
    }
  }
  throw new Error('no code block');
}

/** A new paragraph holding a formula decorator that names `key`. */
function paragraphNaming(doc: Y.Doc, key: string): void {
  const paragraph = block('paragraph');
  root(doc).insertEmbed(root(doc).length, paragraph);
  const formula = new Y.XmlElement();
  paragraph.insertEmbed(0, formula);
  formula.setAttribute('__type', 'formula');
  formula.setAttribute('__regId', key);
}

describe('T5.0 reject and withdraw never write the body @p:mean-2 @p:R16', () => {
  it.each(['reject', 'withdraw'] as const)('%s leaves the body and every payload byte-identical; only meta, ops and parts change', (how) => {
    const { live, suggest, proposeDelete, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More.'), () => codeBlock().setCode('seed!'), insertBlock('```js\nnew code\n```')]);
      expect(readRecord(live, 'r1')!.ops.some((op) => op.doc !== 'body'), 'the record carries payload ops').toBe(true);
      expect(proposeDelete('r1', { id: 'd1', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true });
      const body = bodyOf(live);
      const watch = changedRoots(live);
      const result = how === 'reject' ? rejectRecord(live, 'r1', EDITOR) : withdrawRecord(live, 'r1', { id: SUGGESTER.id, role: 'suggester' });
      watch.stop();
      expect(result).toEqual({ ok: true });
      expect(bodyOf(live)).toBe(body);
      expect([...watch.roots]).toEqual(['suggestions']);
      const record = readRecord(live, 'r1')!;
      expect(record.meta.status).toBe(how === 'reject' ? 'rejected' : 'withdrawn');
      expect(record.ops).toEqual([]);
      expect(record.parts).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('only an editor rejects, and only the author withdraws', () => {
    const { live, suggest, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More.')]);
      const body = bodyOf(live);
      expect(rejectRecord(live, 'r1', { id: OTHER_SUGGESTER.id, role: 'suggester' })).toMatchObject({ ok: false, status: 403 });
      expect(withdrawRecord(live, 'r1', { id: OTHER_SUGGESTER.id, role: 'suggester' })).toMatchObject({ ok: false, status: 403 });
      expect(readMeta(live, 'r1')!.status).toBe('open');
      expect(bodyOf(live)).toBe(body);
    } finally {
      dispose();
    }
  });
});

type Gate = { name: string; reason: string; ops: (live: Y.Doc) => RecordOp[]; clients?: number[] };

const GATES: Gate[] = [
  {
    name: 'G1: a clock gap',
    reason: 'unresolvable',
    ops: (live) => bodyOps(updatesOf(live, (doc) => {
      root(doc).insertEmbed(root(doc).length, block('paragraph'));
      root(doc).insertEmbed(root(doc).length, block('paragraph'));
    }).slice(1)),
  },
  {
    name: 'G1: a payload op with a clock gap',
    reason: 'unresolvable',
    ops: (live) => payloadUpdatesOf(live, codeDecorator(live).key, (text) => {
      text.insert(0, 'a');
      text.insert(0, 'b');
    }).slice(1),
  },
  {
    name: 'G1: a missing origin',
    reason: 'unresolvable',
    ops: (live) => bodyOps(updatesOf(live, (doc) => {
      doc.clientID = 0x6fff0001;
      root(doc).insertEmbed(root(doc).length, block('paragraph'));
      doc.clientID = LEASED;
      root(doc).insertEmbed(root(doc).length, block('paragraph'));
    }).slice(1)),
  },
  {
    name: 'G2: a client the record does not lease',
    reason: 'foreign-client',
    ops: (live) => [forged(live, (doc) => root(doc).insertEmbed(root(doc).length, block('paragraph')), 0x6fff0002)],
  },
  {
    name: "G2: a payload update outside the record's leases",
    reason: 'foreign-client',
    ops: (live) => [payloadOp(live, codeDecorator(live).key, (text) => text.insert(0, 'x'), 0x6fff0003)],
  },
  ...(['title', 'frontmatter', 'comments', 'suggestions'] as const).map((name): Gate => ({
    name: `G3: a write to ${name}`,
    reason: 'outside-body',
    ops: (live) => [forged(live, (doc) => (name === 'title' ? doc.getText('title').insert(0, 'x') : doc.getMap(name).set('forged', 'x')))],
  })),
  {
    name: 'G3: a write to the retired registers map',
    reason: 'outside-body',
    ops: (live) => [forged(live, (doc) => doc.getMap('registers').set('forged', new Y.Text('x')))],
  },
  {
    name: "G3: a payload op outside the payload's own types",
    reason: 'outside-body',
    ops: (live) => [payloadOp(live, codeDecorator(live).key, (_text, doc) => doc.getMap('elsewhere').set('forged', 'x'))],
  },
  {
    name: 'G4: a fresh decorator naming an original payload',
    reason: 'payload-alias',
    ops: (live) => [forged(live, (doc) => paragraphNaming(doc, codeDecorator(doc).key))],
  },
  {
    name: "G4: a fresh decorator naming a peer's payload",
    reason: 'payload-alias',
    ops: (live) => {
      const before = new Set(payloadDocsFor(live).docs.keys());
      editorEdits(live, insertBlock('```js\npeer code\n```'));
      const peer = [...payloadDocsFor(live).docs.keys()].find((key) => !before.has(key))!;
      expect(peer, 'the peer minted a payload').toBeTruthy();
      return [forged(live, (doc) => paragraphNaming(doc, peer))];
    },
  },
  {
    name: 'G4: a fresh decorator naming a withheld payload',
    reason: 'payload-alias',
    ops: (live) => {
      const key = withheldCode(live);
      return [forged(live, (doc) => paragraphNaming(doc, key))];
    },
  },
  {
    name: 'G4: an edit to a withheld payload',
    reason: 'payload-alias',
    ops: (live) => {
      const key = withheldCode(live);
      return [payloadOp(live, key, (text) => text.insert(0, 'x'))];
    },
  },
  {
    name: 'G4: an original decorator re-pointed',
    reason: 'payload-alias',
    ops: (live) => [
      forged(live, (doc) => codeDecorator(doc).element.setAttribute('__regId', 'fresh-key')),
      payloadOp(live, 'fresh-key', (text) => text.insert(0, 'forged')),
    ],
  },
  {
    name: 'G4: two fresh decorators naming one new payload',
    reason: 'payload-alias',
    ops: (live) => [
      forged(live, (doc) => {
        paragraphNaming(doc, 'fresh-key');
        paragraphNaming(doc, 'fresh-key');
      }),
      payloadOp(live, 'fresh-key', (text) => text.insert(0, 'shared')),
    ],
  },
  {
    name: 'G7: an unregistered node type',
    reason: 'broken',
    ops: (live) => [forged(live, (doc) => root(doc).insertEmbed(root(doc).length, block('no-such-node')))],
  },
  {
    name: 'G7: a list item under the root',
    reason: 'broken',
    ops: (live) => [forged(live, (doc) => root(doc).insertEmbed(root(doc).length, block('listitem', { __value: 1 })))],
  },
];

describe('T5.0 accept gates refuse forged records with nothing applied @p:mean-2', () => {
  it.each(GATES)('$name → $reason', ({ ops, reason, clients }) => {
    const live = seededBody();
    forgeRecord(live, 'g', clients ?? [LEASED], ops(live));
    const body = bodyOf(live);
    const record = readRecord(live, 'g')!;
    const preview = previewRecord(live, 'g');
    expect(preview).toMatchObject({ ok: false, reason });
    expect(acceptRecord(live, 'g', { previewHash: 'none', digest: recordDigest(record) }, EDITOR)).toEqual({ ok: false, status: 409, reason });
    expect(bodyOf(live)).toBe(body);
    expect(readMeta(live, 'g')!.status).toBe('open');
  });

  it('G0: an accept of ops other than those previewed is refused', () => {
    const { live, suggest, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More.')]);
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(preview.reason);
      suggest('r1', [() => select('join tail', 0).insertText('Also ')]);
      const body = bodyOf(live);
      expect(acceptRecord(live, 'r1', { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toMatchObject({ ok: false, status: 409 });
      expect(bodyOf(live)).toBe(body);
    } finally {
      dispose();
    }
  });

  it('only an editor accepts', () => {
    const { live, suggest, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More.')]);
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(preview.reason);
      expect(acceptRecord(live, 'r1', { previewHash: preview.hash, digest: preview.digest }, { id: SUGGESTER.id, role: 'suggester' }))
        .toMatchObject({ ok: false, status: 403 });
    } finally {
      dispose();
    }
  });
});

describe('T5.0 G5: a record whose context changed is outdated @p:mean-2', () => {
  const outdated = (live: Y.Doc, accept: () => unknown, id: string) => {
    const body = bodyOf(live);
    expect(accept()).toEqual({ ok: false, status: 409, reason: 'outdated' });
    expect(bodyOf(live)).toBe(body);
    expect(readMeta(live, id)).toMatchObject({ status: 'open', outdated: ['outdated'] });
  };

  it('an editor types inside the run a bold record removed', () => {
    const { live, suggest, accept, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 6, 11).formatText('bold')]);
      editorEdits(live, () => select('Hello', 9).insertText('X'));
      outdated(live, () => accept('r1'), 'r1');
    } finally {
      dispose();
    }
  });

  it('an editor deletes a delete-part target', () => {
    const { live, proposeDelete, accept, dispose } = setup();
    try {
      expect(proposeDelete('r1', { id: 'd1', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true });
      editorEdits(live, () => select('Hello', 6, 11).removeText());
      outdated(live, () => accept('r1'), 'r1');
    } finally {
      dispose();
    }
  });

  it('an editor deletes, and Yjs collects, the paragraph a record inserts into', () => {
    const { live, suggest, accept, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More.')]);
      editorEdits(live, () => select('Hello', 0).getNodes()[0].getParentOrThrow().remove());
      outdated(live, () => accept('r1'), 'r1');
    } finally {
      dispose();
    }
  });

  it("an editor types inside the payload text a record's payload op removed", () => {
    const { live, suggest, accept, dispose } = setup();
    try {
      suggest('r1', [() => codeBlock().setCode('sd')]);
      editorEdits(live, () => codeBlock().setCode('seXed'));
      outdated(live, () => accept('r1'), 'r1');
    } finally {
      dispose();
    }
  });

  it('two records bold the same text: the second is outdated once the first is accepted', () => {
    const { live, suggest, accept, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 6, 11).formatText('bold')]);
      suggest('r2', [() => select('Hello', 6, 11).formatText('bold')], OTHER_SUGGESTER);
      expect(accept('r1')).toEqual({ ok: true });
      outdated(live, () => accept('r2'), 'r2');
    } finally {
      dispose();
    }
  });
});

describe('T5.0 the projection a reviewer sees @p:mean-2', () => {
  it.each([
    ['text-only', () => select('Hello', 24).insertText(' More.'), 'block'],
    ['attribute-only', () => listItem('task one').setChecked(true), 'block'],
    ['payload-only', () => codeBlock().setCode('seed!'), 'payload'],
  ] as const)('a %s record has a hunk', (_name, step, kind) => {
    const { live, suggest, dispose } = setup();
    try {
      suggest('r1', [step]);
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(preview.reason);
      expect(preview.hunks.filter((hunk) => hunk.kind === kind && hunk.op === 'changed').length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });

  it("an edit of an original payload is a proposal: the payload changes only at accept, as the preview showed", () => {
    const { live, suggest, accept, dispose } = setup();
    try {
      const { key } = codeDecorator(live);
      suggest('r1', [() => codeBlock().setCode('seed!')]);
      const payload = payloadDocsFor(live).get(key)!;
      expect(payload.getText('payload').toString(), 'ingest writes no payload').toBe('seed');
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(preview.reason);
      expect(preview.hunks.find((hunk) => hunk.kind === 'payload' && hunk.id === key)).toMatchObject({
        op: 'changed', before: { text: 'seed' }, after: { text: 'seed!' },
      });
      expect(accept('r1')).toEqual({ ok: true });
      expect(payload.getText('payload').toString()).toBe('seed!');
      expect(payloadsInOrder(live)).toContain(JSON.stringify({ text: 'seed!', map: {} }));
    } finally {
      dispose();
    }
  });

  it('a payload op no element names is shown in the preview and lands only as shown', () => {
    const { live, suggest, accept, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More.')]);
      const [lease] = readMeta(live, 'r1')!.clients;
      writeSuggestions(live, () => opsOf(live, 'r1').push([payloadOp(live, 'unnamed-fresh', (text) => text.insert(0, 'hidden'), lease)]));
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(preview.reason);
      expect(preview.hunks.find((hunk) => hunk.kind === 'payload' && hunk.id === 'unnamed-fresh')).toMatchObject({ op: 'added', after: { text: 'hidden' } });
      expect(accept('r1')).toEqual({ ok: true });
      expect(payloadDocsFor(live).get('unnamed-fresh')?.getText('payload').toString()).toBe('hidden');
    } finally {
      dispose();
    }
  });

  it("a payload edit whose decorator the record removes shows the payload's new text", () => {
    const { live, suggest, accept, dispose } = setup();
    try {
      const { key } = codeDecorator(live);
      suggest('r1', [() => codeBlock().setCode('replaced'), () => codeBlock().remove()]);
      expect(readRecord(live, 'r1')!.ops.some((op) => op.doc === key), 'the record edits the payload').toBe(true);
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(preview.reason);
      expect(preview.hunks.find((hunk) => hunk.kind === 'payload' && hunk.id === key)).toMatchObject({
        op: 'changed', before: { text: 'seed' }, after: { text: 'replaced' },
      });
      expect(accept('r1')).toEqual({ ok: true });
      expect(payloadDocsFor(live).get(key)!.getText('payload').toString()).toBe('replaced');
    } finally {
      dispose();
    }
  });

  it.each([
    ["an attribute on an original payload's text", (text: Y.Text) => text.setAttribute('hidden', 'x')],
    ['a nested text in the payload map', (_text: Y.Text, doc: Y.Doc) => doc.getMap('payload-map').set('nested', new Y.Text('n'))],
  ] as const)('%s is outside the channel table: preview and accept refuse it, with nothing applied', (_name, write) => {
    const { live, suggest, dispose } = setup();
    try {
      const { key } = codeDecorator(live);
      suggest('r1', [() => select('Hello', 24).insertText(' More.')]);
      const [lease] = readMeta(live, 'r1')!.clients;
      writeSuggestions(live, () => opsOf(live, 'r1').push([payloadOp(live, key, write, lease)]));
      const body = bodyOf(live);
      expect(previewRecord(live, 'r1')).toMatchObject({ ok: false, reason: 'outside-body' });
      const record = readRecord(live, 'r1')!;
      expect(acceptRecord(live, 'r1', { previewHash: 'none', digest: recordDigest(record) }, EDITOR)).toEqual({ ok: false, status: 409, reason: 'outside-body' });
      expect(bodyOf(live)).toBe(body);
    } finally {
      dispose();
    }
  });

  it("an attribute on the note's root is shown in the preview and lands only as shown", () => {
    const live = seededBody();
    forgeRecord(live, 'g', [LEASED], [forged(live, (doc) => root(doc).setAttribute('__dir', 'rtl'))]);
    const record = readRecord(live, 'g')!;
    const preview = previewRecord(live, 'g');
    if (!preview.ok) throw new Error(preview.reason);
    const hunk = preview.hunks.find((h) => (h.kind as string) === 'note');
    expect(hunk, 'the root attribute is a hunk').toMatchObject({ op: 'changed' });
    expect(acceptRecord(live, 'g', { previewHash: preview.hash, digest: recordDigest(record) }, EDITOR)).toEqual({ ok: true });
    expect(root(live).getAttribute('__dir')).toBe('rtl');
    expect(canonical(projectDoc(live).note)).toBe(canonical(hunk!.after));
  });

  it('a stale preview hash is refused 409 changed, with nothing applied', () => {
    const { live, suggest, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More.')]);
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(preview.reason);
      editorEdits(live, () => select('Hello', 0).insertText('Oh, '));
      const body = bodyOf(live);
      expect(acceptRecord(live, 'r1', { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: false, status: 409, reason: 'changed' });
      expect(bodyOf(live)).toBe(body);
    } finally {
      dispose();
    }
  });
});

describe('T5.3 accept lands exactly the previewed diff or nothing @p:mean-2 @p:R17', () => {
  const EMPTY_HASH = previewHash([]);
  const paragraphOf = (doc: Y.Doc) => (root(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.XmlText) as Y.XmlText;

  it('preview_hash_covers_root_attributes: a root-only and a mixed text-plus-root record each change the hash; a stale hash gets 409', () => {
    for (const mixed of [false, true]) {
      const live = seededBody();
      forgeRecord(live, 'g', [LEASED], [forged(live, (doc) => {
        root(doc).setAttribute('__format', 1 as unknown as string);
        root(doc).setAttribute('__direction', 'rtl');
        if (mixed) paragraphOf(doc).insert(1, 'Oh, ');
      })]);
      const record = readRecord(live, 'g')!;
      const preview = previewRecord(live, 'g');
      if (!preview.ok) throw new Error(preview.reason);
      expect(preview.hunks.some((hunk) => hunk.kind === 'note'), `mixed=${mixed}: the root's keys are a hunk`).toBe(true);
      expect(preview.hash, `mixed=${mixed}`).not.toBe(EMPTY_HASH);
      const body = bodyOf(live);
      expect(acceptRecord(live, 'g', { previewHash: EMPTY_HASH, digest: recordDigest(record) }, EDITOR)).toEqual({ ok: false, status: 409, reason: 'changed' });
      expect(bodyOf(live)).toBe(body);
      expect(acceptRecord(live, 'g', { previewHash: preview.hash, digest: recordDigest(record) }, EDITOR)).toEqual({ ok: true });
      expect(root(live).getAttribute('__direction')).toBe('rtl');
    }
  });

  it('g7_refuses_candidate_repaired_during_hydration: a fresh legacy-shape code block gets 409 broken, body unchanged', () => {
    const live = seededBody();
    forgeRecord(live, 'g', [LEASED], [forged(live, (doc) => {
      const element = new Y.XmlElement();
      root(doc).insertEmbed(root(doc).length, element);
      element.setAttribute('__type', 'code-block');
      element.setAttribute('__code', 'legacy();');
      element.setAttribute('__language', 'js');
    })]);
    const record = readRecord(live, 'g')!;
    const body = bodyOf(live);
    expect(previewRecord(live, 'g')).toMatchObject({ ok: false, reason: 'broken' });
    expect(acceptRecord(live, 'g', { previewHash: 'none', digest: recordDigest(record) }, EDITOR)).toEqual({ ok: false, status: 409, reason: 'broken' });
    expect(bodyOf(live)).toBe(body);
    expect(readMeta(live, 'g')).toMatchObject({ status: 'open', broken: 'broken' });
  });

  it('g5_split_parts_around_foreign_insert_keep_foreign_text_and_preview_shows_it', () => {
    const { live, proposeDelete, dispose } = setup();
    try {
      const [run] = spansOfText(live, 'an');
      expect(run.len).toBe(2);
      expect(proposeDelete('r1', { id: 'd1', targets: [{ client: run.client, clock: run.clock, len: 1 }] })).toMatchObject({ ok: true });
      expect(proposeDelete('r1', { id: 'd2', targets: [{ client: run.client, clock: run.clock + 1, len: 1 }] })).toMatchObject({ ok: true });
      // An editor types X between the two struck characters.
      editorEdits(live, () => select('Hello', 13).insertText('X'));
      expect(exported(live)).toContain('Hello world aXnd the cat.');
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(preview.reason);
      const changed = preview.hunks.filter((hunk) => hunk.kind === 'block' && hunk.op === 'changed');
      expect(changed).toHaveLength(1);
      expect(JSON.stringify(changed[0].after)).toContain('Hello world Xd the cat.');
      const record = readRecord(live, 'r1')!;
      expect(acceptRecord(live, 'r1', { previewHash: preview.hash, digest: recordDigest(record) }, EDITOR)).toEqual({ ok: true });
      expect(exported(live)).toContain('Hello world Xd the cat.');
    } finally {
      dispose();
    }
  });

  it("G3 covers Yjs's formatting cleanup in the body: deleting an editor's formatted run is refused outside-body, nothing applied", () => {
    const live = seededBody();
    live.transact(() => paragraphOf(live).insert(6, 'ZZ', { bold: true }));
    const targets = spansOfText(live, 'ZZ');
    expect(targets).toHaveLength(1);
    forgeRecord(live, 'g', [LEASED], [], [{ id: 'd1', kind: 'delete', targets, quote: 'ZZ' }]);
    const record = readRecord(live, 'g')!;
    const before = Y.encodeStateAsUpdate(live);
    expect(previewRecord(live, 'g')).toMatchObject({ ok: false, reason: 'outside-body' });
    expect(acceptRecord(live, 'g', { previewHash: 'none', digest: recordDigest(record) }, EDITOR)).toEqual({ ok: false, status: 409, reason: 'outside-body' });
    expect(Y.encodeStateAsUpdate(live)).toEqual(before);
  });

  it("G3 covers Yjs's formatting cleanup in a payload: a payload op over an editor's formatted run is refused, the payload untouched", () => {
    const live = seededBody();
    const { key } = codeDecorator(live);
    const payload = payloadDocsFor(live).get(key)!;
    payload.transact(() => payload.getText('payload').format(0, 2, { bold: true }));
    const before = Y.encodeStateAsUpdate(payload);
    forgeRecord(live, 'g', [LEASED], [payloadOp(live, key, (text) => text.delete(0, 2))]);
    const record = readRecord(live, 'g')!;
    expect(previewRecord(live, 'g')).toMatchObject({ ok: false, reason: 'outside-body' });
    expect(acceptRecord(live, 'g', { previewHash: 'none', digest: recordDigest(record) }, EDITOR)).toEqual({ ok: false, status: 409, reason: 'outside-body' });
    expect(Y.encodeStateAsUpdate(payload)).toEqual(before);
    expect(payload.getText('payload').toString()).toBe('seed');
  });

  it('the deletion coverage check is interval-based: a 2,500-span part beside 400,000 characters is judged in well under a second', () => {
    const live = new Y.Doc();
    const paragraph = block('paragraph');
    root(live).insertEmbed(0, paragraph);
    paragraph.insert(0, 'x'.repeat(400_000));
    const first = (paragraph._start as Y.Item).id;
    const targets = Array.from({ length: 2_500 }, (_, i) => ({ client: first.client, clock: first.clock + i, len: 1 }));
    const record = {
      meta: { v: 2, id: 'g', author: SUGGESTER.id, authorName: SUGGESTER.name, source: 'live', createdAt: 1, updatedAt: 1, status: 'open', clients: [LEASED] } as RecordMeta,
      ops: [] as RecordOp[],
      parts: [{ id: 'd1', kind: 'delete' as const, targets, quote: '' }],
    };
    const mirror = hydrate(live);
    const started = performance.now();
    const result = applyRecord(mirror, record);
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ ok: true });
    expect(elapsed).toBeLessThan(1_000);
  });

  it('a record whose preview is empty is auto-rejected by the system once idle', () => {
    const live = seededBody();
    forgeRecord(live, 'g', [LEASED], bodyOps(updatesOf(live, (doc) => {
      paragraphOf(doc).insert(1, 'x');
      paragraphOf(doc).delete(1, 1);
    })));
    const body = bodyOf(live);
    expect(previewRecord(live, 'g')).toMatchObject({ ok: true, hunks: [] });
    expect(reviewPreview(live, 'g', { now: 2 })).toMatchObject({ ok: true, hunks: [] });
    expect(readMeta(live, 'g')!.status, 'not idle yet').toBe('open');
    expect(reviewPreview(live, 'g', { now: 60_000 })).toMatchObject({ ok: true, hunks: [], closed: true });
    expect(readMeta(live, 'g')).toMatchObject({ status: 'rejected', resolvedBy: 'system' });
    expect(bodyOf(live)).toBe(body);
  });

  it('the default export is the clean body; the working view adds every valid open record', () => {
    const { live, suggest, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More words.')]);
      suggest('r2', [() => select('join tail', 0).insertText('Also ')], OTHER_SUGGESTER);
      forgeRecord(live, 'bad', [LEASED], [forged(live, (doc) => root(doc).insertEmbed(root(doc).length, block('no-such-node')))]);
      const clean = exported(live);
      expect(clean).not.toContain('More words.');
      const working = exportWorkingMarkdown(live, NOTE_ID);
      expect(working).toContain('Hello world and the cat. More words.');
      expect(working).toContain('Also join tail.');
      expect(exported(live)).toBe(clean);
      for (const id of ['r1', 'r2', 'bad']) expect(readMeta(live, id)!.status).toBe('open');
    } finally {
      dispose();
    }
  });
});
