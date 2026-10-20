// T5.B4 (B308): "Copy suggested text" copies what the record proposes as it stands: the author's text that survives
// the author's own later edits, in document order with each payload's text where its block is, whitespace intact.
// Separate places are separate lines. A record whose place is gone (outdated) still copies what it typed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { RecordOp } from '@moss-multi/core/suggest/apply';
import { payloadDocsFor } from '../../../../../../packages/sync/src/payload-docs.ts';
import { readRecord } from '../../../../../../packages/sync/src/suggest/records.ts';
import { deterministicIds, forgeRecord, LEASED, seededBody } from '../../../../../../packages/sync/src/suggest/test-support.ts';
import { suggestedText } from './copy-text.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
const blocks = (doc: Y.Doc) => (root(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert);
const block = (doc: Y.Doc, text: string) => blocks(doc).find((x) => x instanceof Y.XmlText && x.toString().includes(text)) as Y.XmlText;
const codeKey = (doc: Y.Doc) => String((blocks(doc).find((x) => x instanceof Y.XmlElement && x.getAttribute('__type') === 'code-block') as Y.XmlElement).getAttribute('__regId'));

/** The author's fork of `source` under the lease: each transaction is one op, as a fork forwards them. */
function fork(source: Y.Doc, doc: string) {
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
  copy.clientID = LEASED;
  const ops: RecordOp[] = [];
  copy.on('update', (update: Uint8Array) => ops.push({ doc, update }));
  return { copy, ops, step: (write: (copy: Y.Doc) => void) => copy.transact(() => write(copy)) };
}

/** A record that types, replaces, types before what it typed, deletes some of its own text and adds indented code. */
function authored(live: Y.Doc): RecordOp[] {
  const body = fork(live, 'body');
  const hello = (doc: Y.Doc) => block(doc, 'Hello world');
  const join = (doc: Y.Doc) => block(doc, 'Join head.');
  body.step((doc) => hello(doc).insert(hello(doc).length, ' quick'));
  body.step((doc) => {
    hello(doc).delete(hello(doc).length - 6, 6);
    hello(doc).insert(hello(doc).length, ' brisk');
  });
  body.step((doc) => hello(doc).insert(1, 'Oh, '));
  body.step((doc) => join(doc).insert(join(doc).length, ' abcdef'));
  body.step((doc) => join(doc).delete(join(doc).length - 4, 2));
  const key = codeKey(live);
  const code = fork(payloadDocsFor(live).get(key)!, key);
  code.step((doc) => doc.getText('payload').insert(0, '  indented()\n\n'));
  body.copy.destroy();
  code.copy.destroy();
  return [...body.ops.slice(0, 3), ...code.ops, ...body.ops.slice(3)];
}

const EXPECTED = ['Oh, ', ' brisk', '  indented()\n\n', ' abef'].join('\n');

describe('T5.B4 copy suggested text copies the surviving proposed text @p:mean-2 @p:R17', () => {
  it('in document and payload order, without the replaced or deleted text, with whitespace intact', () => {
    const live = seededBody();
    forgeRecord(live, 'g', authored(live));
    expect(suggestedText(readRecord(live, 'g')!, live)).toBe(EXPECTED);
  });

  it('an outdated record, whose paragraph an editor removed, still copies what it typed there', () => {
    const live = seededBody();
    forgeRecord(live, 'g', authored(live));
    const at = blocks(live).findIndex((x) => x instanceof Y.XmlText && x.toString().includes('Join head.'));
    root(live).delete(at, 1);
    expect(suggestedText(readRecord(live, 'g')!, live)).toBe(EXPECTED);
  });
});
