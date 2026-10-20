// T5.B4 (B288): the client composite C is rebuilt from a chain of per-record checkpoints. A rebuild after only the last
// record changed copies the note a constant number of times, not once per open record; and whatever changed (a
// record, the body, a payload outside the records, a closed record, a record that fails), the result is the one a
// fresh full build gives.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { RecordMeta } from '@moss-multi/core/suggest/apply';
import { payloadDocsFor, payloadText } from '../payload-docs.ts';
import { Composite, destroyView, type Built } from './client.ts';
import { closeRecord, createRecord, opsOf, writeSuggestions } from './records.ts';
import { deterministicIds, exported, seededBody, SEED } from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

const LINES = 1500;
const RECORDS = 12;
const BASE = 0x7ff00000;
const BROKEN = BASE + 99;

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
const blocks = (doc: Y.Doc) => (root(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert);
const line = (doc: Y.Doc, n: number) => blocks(doc).find((x) => x instanceof Y.XmlText && x.toString().includes(`Line ${n} words.`)) as Y.XmlText;
const codeKey = (doc: Y.Doc) => String((blocks(doc).find((x) => x instanceof Y.XmlElement && x.getAttribute('__type') === 'code-block') as Y.XmlElement).getAttribute('__regId'));

/** Item integrations while `run` runs: a copy of the note integrates each of its items once. */
function integrations<T>(run: () => T): { count: number; result: T } {
  const proto = Y.Item.prototype as unknown as { integrate: (...args: unknown[]) => unknown };
  const own = proto.integrate;
  let count = 0;
  proto.integrate = function integrate(this: unknown, ...args: unknown[]) {
    count += 1;
    return own.apply(this, args);
  };
  try {
    return { count, result: run() };
  } finally {
    proto.integrate = own;
  }
}

const items = (doc: Y.Doc) => [...doc.store.clients.values()].reduce((sum, list) => sum + list.filter((s) => s instanceof Y.Item).length, 0);

/** One op under `client`, written on a gc-free copy of `source` (which may already hold the client's earlier ops). */
function opUnder(source: Y.Doc, client: number, write: (copy: Y.Doc) => void): { update: Uint8Array; copy: Y.Doc } {
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
  copy.clientID = client;
  const sv = Y.encodeStateVector(copy);
  write(copy);
  return { update: Y.encodeStateAsUpdate(copy, sv), copy };
}

function addRecord(live: Y.Doc, id: string, createdAt: number, clients: number[], ops: { doc: string; update: Uint8Array }[]): void {
  const meta: RecordMeta = {
    v: 2, id, author: 'suggester-1@example.invalid', authorName: 'Sam Suggester', source: 'live', createdAt, updatedAt: createdAt, status: 'open', clients,
  };
  writeSuggestions(live, () => {
    createRecord(live, meta);
    opsOf(live, id).push(ops);
  });
}

/**
 * A large note with many small open records, each typing into its own line under its own client; one in the middle
 * fails the bind check, one edits the code block's payload.
 */
function setup() {
  const markdown = `${SEED}\n\n${Array.from({ length: LINES }, (_, n) => `Line ${n} words.`).join('\n\n')}\n`;
  const live = seededBody(markdown);
  const copies = new Map<string, Y.Doc>();
  for (let i = 0; i < RECORDS; i++) {
    const client = BASE + i;
    const { update, copy } = opUnder(live, client, (doc) => line(doc, i).insert(1, `r${i} `));
    copies.set(`r${i}`, copy);
    addRecord(live, `r${i}`, 10 + i, [client], [{ doc: 'body', update }]);
  }
  const broken = opUnder(live, BROKEN, (doc) => line(doc, 500).insert(1, 'broken '));
  broken.copy.destroy();
  addRecord(live, 'broken', 10 + RECORDS / 2 + 0.5, [BROKEN], [{ doc: 'body', update: broken.update }]);
  const key = codeKey(live);
  const payload = opUnder(payloadDocsFor(live).get(key)!, BASE + 50, (doc) => doc.getText('payload').insert(0, 'proposed '));
  payload.copy.destroy();
  addRecord(live, 'code', 10 + RECORDS / 2 + 0.25, [BASE + 50], [{ doc: key, update: payload.update }]);
  // The bind check, by the record's clients: the broken record fails it; every other passes.
  const check = (_doc: Y.Doc, inserted: ReadonlyMap<number, unknown>) => !inserted.has(BROKEN);
  return { live, copies, check, key };
}

/** What a build shows: its lists, its note, its state and its payloads' text. */
function reading(built: Built) {
  return {
    valid: built.valid,
    broken: built.broken,
    waiting: built.waiting,
    clients: [...built.clients].sort(),
    markdown: exported(built.doc),
    snapshot: Y.encodeSnapshot(Y.snapshot(built.doc)),
    payloads: [...built.payloads].map(([id, doc]) => [id, payloadText(doc).toString()]).sort(),
  };
}

describe('T5.B4 the composite is rebuilt from the first changed record @p:mean-2 @p:R17', () => {
  it('editing only the last record copies the note a constant number of times; each rebuild equals a fresh build', () => {
    const { live, copies, check, key } = setup();
    const note = items(live);
    const composite = new Composite(live, { check });
    const fresh = () => {
      const built = new Composite(live, { check }).build();
      try {
        return reading(built);
      } finally {
        destroyView(built);
      }
    };
    const rebuild = (what: string, copiesAtMost?: number) => {
      const { count, result } = integrations(() => composite.build());
      try {
        expect(reading(result), `${what}: the rebuild equals a fresh build`).toEqual(fresh());
        if (copiesAtMost !== undefined) expect(count, `${what}: ${count} integrations for a note of ${note} items`).toBeLessThanOrEqual(copiesAtMost * note);
        return reading(result);
      } finally {
        destroyView(result);
      }
    };
    const first = rebuild('the first build');
    expect(first.valid).toHaveLength(RECORDS + 1);
    expect(first.broken).toEqual(['broken']);
    expect(first.markdown).toContain('r0 Line 0 words.');
    expect(first.markdown).toContain(`r${RECORDS - 1} Line ${RECORDS - 1} words.`);

    // Only the last record changes: its author types more.
    const last = `r${RECORDS - 1}`;
    const more = opUnder(copies.get(last)!, BASE + RECORDS - 1, (doc) => line(doc, RECORDS - 1).insert(1, 'more '));
    more.copy.destroy();
    writeSuggestions(live, () => opsOf(live, last).push([{ doc: 'body', update: more.update }]));
    expect(rebuild('the last record grew', 3).markdown).toContain(`more r${RECORDS - 1} Line`);
    // Nothing changed: still a constant.
    rebuild('nothing changed', 2);

    // A record in the middle closes: the records after it are applied again, not the ones before.
    closeRecord(live, 'r8', { status: 'withdrawn', resolvedBy: 'suggester-1@example.invalid', resolvedAt: 1 });
    expect(rebuild('a record closed', 3 + (RECORDS - 8)).markdown).not.toContain('r8 Line');

    // The body changes outside the records: everything is rebuilt, and reads the new body.
    line(live, 1200).insert(1, 'edited ');
    expect(rebuild('the body changed').markdown).toContain('edited Line 1200');

    // B's payload changes outside the records: the record editing it reads the new payload.
    payloadText(payloadDocsFor(live).get(key)!).insert(payloadText(payloadDocsFor(live).get(key)!).length, ' tail');
    expect(rebuild('a payload changed').payloads).toEqual([[key, 'proposed seed tail']]);
    // And with nothing changed since, a rebuild is a constant again.
    rebuild('nothing changed since', 2);
  }, 120_000);
});
