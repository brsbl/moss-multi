// T5.0 spike, tests 4–7 (docs/design/suggestions.md §9): reject and withdraw never write the body; forged records
// meet each accept gate with nothing applied; a record whose context an editor changed is outdated; the projection a
// reviewer sees covers text, attributes and registers, and binds the accept.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { recordDigest, type DeletePart, type RecordMeta } from '@moss-multi/core/suggest/apply';
import { SuggestIngest } from '../doc/suggest.ts';
import { ForkShim } from './fork-shim.ts';
import { createRecord, opsOf, partsOf, readMeta, readRecord, SUGGESTIONS_ORIGIN } from './records.ts';
import { acceptRecord, nodeRegistry, previewRecord, rejectRecord, withdrawRecord } from './review.ts';
import {
  bodyOf, changedRoots, codeBlock, deterministicIds, editorEdits, EDITOR, insertBlock, listItem, OTHER_SUGGESTER, select, seededBody, spansOfText,
  SUGGESTER,
} from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

function setup() {
  const live = seededBody();
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
  const forks: ForkShim[] = [];
  /** A suggester's fork makes `steps` into record `id`. */
  const suggest = (id: string, steps: (() => void)[], who = SUGGESTER) => {
    const [lease] = ingest.lease(who.id);
    const fork = new ForkShim(live, lease);
    forks.push(fork);
    for (const step of steps) fork.act(step);
    for (const update of fork.sent) {
      const result = ingest.ops(who, 'suggester', id, update);
      if (!result.ok) throw new Error(`ingest refused: ${result.reason}`);
    }
    return fork;
  };
  const accept = (id: string, hash?: string) => {
    const record = readRecord(live, id)!;
    const preview = previewRecord(live, id);
    return acceptRecord(live, id, { previewHash: hash ?? (preview.ok ? preview.hash : 'none'), digest: recordDigest(record) }, EDITOR);
  };
  return { live, ingest, suggest, accept, dispose: () => forks.forEach((fork) => fork.dispose()) };
}

const LEASED = 0x7fff1234;

/** A record written straight into the map, as if ingest were bypassed: the gates must stand alone. */
function forgeRecord(live: Y.Doc, id: string, clients: number[], ops: Uint8Array[], parts: DeletePart[] = []): void {
  const meta: RecordMeta = {
    v: 2, id, author: SUGGESTER.id, authorName: SUGGESTER.name, source: 'live', createdAt: 1, updatedAt: 1, status: 'open', clients,
  };
  live.transact(() => {
    createRecord(live, meta);
    opsOf(live, id).push(ops);
    partsOf(live, id).push(parts);
  }, SUGGESTIONS_ORIGIN);
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

const forged = (live: Y.Doc, write: (doc: Y.Doc) => void, client = LEASED): Uint8Array => Y.mergeUpdates(updatesOf(live, write, client));

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);

function block(type: string, attrs: Record<string, unknown> = {}): Y.XmlText {
  const text = new Y.XmlText();
  text.setAttribute('__type', type);
  for (const [key, value] of Object.entries(attrs)) text.setAttribute(key, value as string);
  return text;
}

/** The live top-level code-block decorator's element and its register key. */
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
  it.each(['reject', 'withdraw'] as const)('%s leaves the body byte-identical; only meta, ops and parts change', (how) => {
    const { live, ingest, suggest, dispose } = setup();
    try {
      suggest('r1', [() => select('Hello', 24).insertText(' More.')]);
      expect(ingest.delete(SUGGESTER, 'suggester', 'r1', { id: 'd1', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true });
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

type Gate = { name: string; reason: string; ops: (live: Y.Doc) => Uint8Array[]; clients?: number[] };

const GATES: Gate[] = [
  {
    name: 'G1: a clock gap',
    reason: 'unresolvable',
    ops: (live) => updatesOf(live, (doc) => {
      root(doc).insertEmbed(root(doc).length, block('paragraph'));
      root(doc).insertEmbed(root(doc).length, block('paragraph'));
    }).slice(1),
  },
  {
    name: 'G1: a missing origin',
    reason: 'unresolvable',
    ops: (live) => updatesOf(live, (doc) => {
      doc.clientID = 0x6fff0001;
      root(doc).insertEmbed(root(doc).length, block('paragraph'));
      doc.clientID = LEASED;
      root(doc).insertEmbed(root(doc).length, block('paragraph'));
    }).slice(1),
  },
  {
    name: 'G2: a client the record does not lease',
    reason: 'foreign-client',
    ops: (live) => [forged(live, (doc) => root(doc).insertEmbed(root(doc).length, block('paragraph')), 0x6fff0002)],
  },
  ...(['title', 'frontmatter', 'comments', 'suggestions'] as const).map((name): Gate => ({
    name: `G3: a write to ${name}`,
    reason: 'outside-body',
    ops: (live) => [forged(live, (doc) => (name === 'title' ? doc.getText('title').insert(0, 'x') : doc.getMap(name).set('forged', 'x')))],
  })),
  {
    name: 'G4: a fresh decorator naming an original register',
    reason: 'register-alias',
    ops: (live) => [forged(live, (doc) => paragraphNaming(doc, codeDecorator(doc).key))],
  },
  {
    name: "G4: a fresh decorator naming a peer's register",
    reason: 'register-alias',
    ops: (live) => {
      const before = new Set(live.getMap('registers').keys());
      editorEdits(live, insertBlock('```js\npeer code\n```'));
      const peer = [...live.getMap('registers').keys()].find((key) => !before.has(key))!;
      return [forged(live, (doc) => paragraphNaming(doc, peer))];
    },
  },
  {
    name: 'G4: an original registers entry replaced',
    reason: 'register-alias',
    ops: (live) => [forged(live, (doc) => doc.getMap('registers').set(codeDecorator(doc).key, new Y.Text('forged')))],
  },
  {
    name: 'G4: an original decorator re-pointed',
    reason: 'register-alias',
    ops: (live) => [forged(live, (doc) => {
      doc.getMap('registers').set('fresh-key', new Y.Text('forged'));
      codeDecorator(doc).element.setAttribute('__regId', 'fresh-key');
    })],
  },
  {
    name: 'G4: an entry deleted while a decorator still names it',
    reason: 'register-alias',
    ops: (live) => [forged(live, (doc) => doc.getMap('registers').delete(codeDecorator(doc).key))],
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
    const { live, ingest, accept, dispose } = setup();
    try {
      expect(ingest.delete(SUGGESTER, 'suggester', 'r1', { id: 'd1', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true });
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
    ['register-only', () => codeBlock().setCode('seed!'), 'register'],
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
