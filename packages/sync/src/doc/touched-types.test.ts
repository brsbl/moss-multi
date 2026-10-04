// SP7 (T4.0, A§13): the DocDO must know which root shared types a client frame would touch before applying it, so a
// frame that writes `comments` or `suggestions` (or any root outside the client allowlist) never lands.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { touchedTypes } from './touched-types.ts';

const SERVER = 'server-comment';

/** A server doc in V1's shape: a paragraph XmlText (text-node map + text) under root, a title, two comments. */
function server(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const paragraph = new Y.XmlText();
    doc.get('root', Y.XmlText).insertEmbed(0, paragraph);
    paragraph.insertEmbed(0, new Y.Map());
    paragraph.insert(1, 'The quick brown fox');
    doc.getText('title').insert(0, 'Title');
    const thread = new Y.Map<unknown>();
    doc.getMap('comments').set('c1', thread);
    thread.set('text', 'first');
    doc.getMap('comments').set('c2', { text: 'plain' });
  }, SERVER);
  return doc;
}

function copyOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

const frame = (client: Y.Doc, target: Y.Doc) => Y.encodeStateAsUpdate(client, Y.encodeStateVector(target));
const paragraphOf = (doc: Y.Doc, index = 0) => doc.get('root', Y.XmlText).toDelta()[index].insert as Y.XmlText;
const verdict = (doc: Y.Doc, update: Uint8Array) => {
  const { roots, unresolved } = touchedTypes(doc, update);
  return { roots: [...roots].sort(), unresolved };
};

/** Ground truth: apply to a copy and read every changed type's root. */
type SharedType = Y.Transaction['changed'] extends Map<infer K, unknown> ? K : never;
function appliedRoots(doc: Y.Doc, update: Uint8Array): string[] {
  const copy = copyOf(doc);
  const changed: SharedType[] = [];
  copy.on('afterTransaction', (transaction: Y.Transaction) => {
    for (const type of transaction.changed.keys()) changed.push(type);
  });
  Y.applyUpdate(copy, update);
  const names = new Map([...copy.share].map(([name, type]) => [type, name] as const));
  const roots = new Set<string>();
  for (let type of changed) {
    while (type._item) type = type._item.parent as SharedType;
    const name = names.get(type);
    if (name !== undefined) roots.add(name);
  }
  copy.destroy();
  return [...roots].sort();
}

describe('SP7: classify a frame by the root types it touches, without applying it @p:tech-3', () => {
  it('typing in a paragraph touches root only, including a run chained on its own earlier item', () => {
    const s = server();
    const c = copyOf(s);
    paragraphOf(c).insert(5, 'very ');
    paragraphOf(c).insert(10, 'very ');
    paragraphOf(c).insert(1, 'Oh, ');
    expect(verdict(s, frame(c, s))).toEqual({ roots: ['root'], unresolved: false });
  });

  it('a title edit touches title only', () => {
    const s = server();
    const c = copyOf(s);
    c.getText('title').insert(5, ' two');
    expect(verdict(s, frame(c, s))).toEqual({ roots: ['title'], unresolved: false });
  });

  it('a client writing a new comment, a field inside a server-written comment, or deleting one touches comments', () => {
    const s = server();
    const added = copyOf(s);
    added.getMap('comments').set('forged', { text: 'mine' });
    expect(verdict(s, frame(added, s))).toEqual({ roots: ['comments'], unresolved: false });

    const nested = copyOf(s);
    (nested.getMap('comments').get('c1') as Y.Map<unknown>).set('text', 'forged');
    expect(verdict(s, frame(nested, s))).toEqual({ roots: ['comments'], unresolved: false });

    const deleted = copyOf(s);
    deleted.getMap('comments').delete('c2');
    expect(verdict(s, frame(deleted, s))).toEqual({ roots: ['comments'], unresolved: false });
  });

  it('a frame that types and writes a comment touches both; a new root name is reported by name', () => {
    const s = server();
    const c = copyOf(s);
    paragraphOf(c).insert(5, 'very ');
    c.getMap('comments').set('forged', { text: 'mine' });
    c.getMap('evil').set('x', 1);
    expect(verdict(s, frame(c, s))).toEqual({ roots: ['comments', 'evil', 'root'], unresolved: false });
  });

  it('a step 2 that only repeats what the server holds is inert', () => {
    const s = server();
    expect(verdict(s, Y.encodeStateAsUpdate(s))).toEqual({ roots: [], unresolved: false });
  });

  it('an item or delete that depends on a server item not yet written is unresolved, so it can never land later', () => {
    const s = server();
    // A doc that writes as the server will next write: the attacker can read the server's client id and clock.
    const future = copyOf(s);
    future.clientID = s.clientID;
    future.getMap('comments').set('next', new Y.Map());
    const parasite = copyOf(future);
    (parasite.getMap('comments').get('next') as Y.Map<unknown>).set('text', 'injected');
    expect(verdict(s, frame(parasite, future)).unresolved).toBe(true);

    const eraser = copyOf(future);
    eraser.getMap('comments').delete('next');
    expect(verdict(s, frame(eraser, future)).unresolved).toBe(true);
  });

  it('classifying applies nothing: the state vector, the root names and the pending queue are unchanged', () => {
    const s = server();
    const c = copyOf(s);
    paragraphOf(c).insert(5, 'very ');
    c.getMap('evil').set('x', 1);
    const before = Y.encodeStateVector(s);
    const names = [...s.share.keys()];
    touchedTypes(s, frame(c, s));
    expect(Y.encodeStateVector(s)).toEqual(before);
    expect([...s.share.keys()]).toEqual(names);
    expect(s.store.pendingStructs).toBeNull();
    expect(s.store.pendingDs).toBeNull();
  });

  type Op =
    | { k: 'type'; p: number; at: number; s: string }
    | { k: 'cut'; p: number; at: number; n: number }
    | { k: 'para'; s: string }
    | { k: 'drop'; p: number }
    | { k: 'title'; at: number; s: string }
    | { k: 'fm'; key: string; value: string }
    | { k: 'reg'; key: string; s: string }
    | { k: 'comment'; key: string; nested: boolean }
    | { k: 'field'; key: string; value: string }
    | { k: 'uncomment'; key: string };

  const key = fc.constantFrom('a', 'b', 'c');
  const word = fc.string({ minLength: 1, maxLength: 4 });
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ k: fc.constant('type' as const), p: fc.nat(3), at: fc.nat(30), s: word }),
    fc.record({ k: fc.constant('cut' as const), p: fc.nat(3), at: fc.nat(30), n: fc.integer({ min: 1, max: 5 }) }),
    fc.record({ k: fc.constant('para' as const), s: word }),
    fc.record({ k: fc.constant('drop' as const), p: fc.nat(3) }),
    fc.record({ k: fc.constant('title' as const), at: fc.nat(10), s: word }),
    fc.record({ k: fc.constant('fm' as const), key, value: word }),
    fc.record({ k: fc.constant('reg' as const), key, s: word }),
    fc.record({ k: fc.constant('comment' as const), key, nested: fc.boolean() }),
    fc.record({ k: fc.constant('field' as const), key, value: word }),
    fc.record({ k: fc.constant('uncomment' as const), key }),
  );

  function apply(doc: Y.Doc, o: Op): void {
    const root = doc.get('root', Y.XmlText);
    const paragraphs = root.toDelta().map((d: { insert: unknown }) => d.insert).filter((t: unknown): t is Y.XmlText => t instanceof Y.XmlText);
    const paragraph = paragraphs.length ? paragraphs[('p' in o ? o.p : 0) % paragraphs.length] : null;
    switch (o.k) {
      case 'type':
        if (paragraph) paragraph.insert(1 + (o.at % paragraph.length), o.s);
        return;
      case 'cut':
        if (paragraph && paragraph.length > 1) {
          const at = 1 + (o.at % (paragraph.length - 1));
          paragraph.delete(at, Math.min(o.n, paragraph.length - at));
        }
        return;
      case 'para': {
        const fresh = new Y.XmlText();
        root.insertEmbed(root.length, fresh);
        fresh.insertEmbed(0, new Y.Map());
        fresh.insert(1, o.s);
        return;
      }
      case 'drop':
        if (paragraphs.length > 1) root.delete(o.p % root.length, 1);
        return;
      case 'title': {
        const title = doc.getText('title');
        title.insert(o.at % (title.length + 1), o.s);
        return;
      }
      case 'fm':
        doc.getMap('frontmatter').set(o.key, o.value);
        return;
      case 'reg': {
        const registers = doc.getMap<Y.Text>('registers');
        const text = registers.get(o.key);
        if (text) text.insert(0, o.s);
        else registers.set(o.key, new Y.Text(o.s));
        return;
      }
      case 'comment':
        if (o.nested) {
          const thread = new Y.Map<unknown>();
          doc.getMap('comments').set(o.key, thread);
          thread.set('text', o.key);
        } else {
          doc.getMap('comments').set(o.key, { text: o.key });
        }
        return;
      case 'field': {
        const thread = doc.getMap('comments').get(o.key);
        if (thread instanceof Y.Map) thread.set('text', o.value);
        return;
      }
      case 'uncomment':
        doc.getMap('comments').delete(o.key);
        return;
    }
  }

  it('agrees with applying the frame for random concurrent edits across every root', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 8 }), fc.array(op, { maxLength: 6 }), fc.array(op, { maxLength: 8 }), (base, concurrent, edits) => {
        const s = server();
        for (const o of base) s.transact(() => apply(s, o), SERVER);
        const c = copyOf(s);
        for (const o of concurrent) s.transact(() => apply(s, o), SERVER);
        for (const o of edits) c.transact(() => apply(c, o));
        const update = frame(c, s);
        const { roots, unresolved } = verdict(s, update);
        expect(unresolved).toBe(false);
        expect(roots).toEqual(appliedRoots(s, update));
      }),
      { numRuns: 300 },
    );
  });
});
