// T5.1 (docs/design/suggestions.md §5): the client's fork F and composite C, with a real moss editor bound to F the
// way the pane binds it and every request answered by the real ingest. F sends nothing when it binds; every census
// operation is recorded with no refusal; a record that fails the bind check is broken and left out of C, and Review
// falls back to the body when binding C throws; a record closed under the author offers back every unacked block,
// and typing after the remount lands.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import type { RecordMeta } from '@moss-multi/core/suggest/apply';
import { handleSuggest, SuggestIngest } from '../doc/suggest.ts';
import { Composite, reviewDoc, SuggestFork, type ForkEvent } from './client.ts';
import { bindEditor } from './fork-shim.ts';
import { createRecord, opsOf, readMeta, readRecord, recordIds, writeSuggestions } from './records.ts';
import { nodeRegistry } from './review.ts';
import { CENSUS, deterministicIds, exported, resetIds, seededBody, select, spansOfText, SUGGESTER, type Step } from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

/** The doc socket between one fork and the DocDO's ingest: requests queue until `deliver` answers them in order. */
function wire(live: Y.Doc, connection = 'c1') {
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
  const outbox: SuggestRequest[] = [];
  const replies: SuggestReply[] = [];
  const who = { ...SUGGESTER, role: 'suggester', connection };
  return {
    ingest,
    outbox,
    replies,
    who,
    send: (request: SuggestRequest) => outbox.push(request),
    deliver(fork: SuggestFork) {
      while (outbox.length) {
        const reply = handleSuggest(ingest, who, outbox.shift()!);
        replies.push(reply);
        fork.receive(reply);
      }
    },
  };
}

/** A fork with a moss editor bound to F before F fills, as the pane's plugin binds it. */
function mount(live: Y.Doc, link: ReturnType<typeof wire>) {
  const events: ForkEvent[] = [];
  const fork = new SuggestFork(live, { me: SUGGESTER.id, name: SUGGESTER.name, send: link.send });
  fork.on((event) => events.push(event));
  const bound = bindEditor(fork.doc);
  fork.begin();
  link.deliver(fork);
  const act = (step: Step) => {
    if (step === 'undo') bound.undo.undo();
    else bound.editor.update(step, { discrete: true });
    bound.editor.update(() => {}, { discrete: true });
  };
  return { fork, bound, events, act, dispose: () => { bound.dispose(); fork.dispose(); } };
}

const ops = (link: ReturnType<typeof wire>) => link.replies.filter((reply) => reply.t !== 'suggest-leased');

describe('T5.1 the fork F @p:mean-2 @p:R17', () => {
  it('sends no op when F binds and fills, before the first input', () => {
    const live = seededBody();
    const link = wire(live);
    const { fork, dispose } = mount(live, link);
    try {
      expect(fork.ready, 'F is filled once its lease arrives').toBe(true);
      expect(fork.doc.clientID, "F writes under the active lease").toBe((link.replies[0] as Extract<SuggestReply, { t: 'suggest-leased' }>).leases[0].client);
      expect(exported(fork.doc), 'F holds the body').toBe(exported(live));
      expect(fork.sent, 'binding and filling F sends nothing').toBe(0);
      expect(link.outbox).toEqual([]);
      expect(ops(link)).toEqual([]);
    } finally {
      dispose();
    }
  });

  it.each(CENSUS)('census through the fork: $name is recorded with no refusal, and the body is untouched', ({ steps }) => {
    const live = seededBody();
    const before = exported(live);
    const link = wire(live);
    resetIds();
    const { fork, act, dispose } = mount(live, link);
    try {
      for (const step of steps) act(step);
      link.deliver(fork);
      expect(fork.sent, 'the operation reaches the wire').toBeGreaterThan(0);
      for (const reply of ops(link)) expect(reply.t).toBe('suggest-ack');
      expect(exported(live), 'a suggestion never writes the body').toBe(before);
      const [record] = recordIds(live);
      expect(readRecord(live, record)?.ops.length).toBe(fork.sent);
    } finally {
      dispose();
    }
  });

  it('a delete over body text is a delete part: the text stays in the body and in F, struck', () => {
    const live = seededBody();
    const before = exported(live);
    const link = wire(live);
    const { fork, dispose } = mount(live, link);
    try {
      const targets = spansOfText(fork.doc, 'world');
      expect(targets.length).toBeGreaterThan(0);
      expect(fork.proposeDelete(targets, 'world')).toBe(true);
      link.deliver(fork);
      expect(ops(link).map((reply) => reply.t)).toEqual(['suggest-ack']);
      const [record] = recordIds(live);
      expect(readRecord(live, record)?.parts.map((part) => part.quote)).toEqual(['world']);
      expect(exported(live)).toBe(before);
      expect(exported(fork.doc), 'F keeps the struck text').toBe(before);
      expect(fork.isStruck(targets[0]), 'the target paints struck').toBe(true);
    } finally {
      dispose();
    }
  });
});

const LEASED = 0x7fff1234;
const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);

/** A record written straight into the map: a list item under the root, which the bind check refuses. */
function forgeBroken(live: Y.Doc, id: string): void {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = LEASED;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
  const sv = Y.encodeStateVector(doc);
  const item = new Y.XmlText();
  item.setAttribute('__type', 'listitem');
  item.setAttribute('__value', 1 as unknown as string);
  root(doc).insertEmbed(root(doc).length, item);
  const op = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();
  const meta: RecordMeta = {
    v: 2, id, author: 'forger@example.invalid', authorName: 'Forger', source: 'live', createdAt: 2, updatedAt: 2, status: 'open', clients: [LEASED],
  };
  writeSuggestions(live, () => {
    createRecord(live, meta);
    opsOf(live, id).push([op]);
  });
}

describe('T5.1 the composite C and Review @p:mean-2 @p:R17', () => {
  function withValidAndBroken() {
    const live = seededBody();
    const link = wire(live);
    const mounted = mount(live, link);
    mounted.act(() => select('Hello', 24).insertText(' Valid insert.'));
    link.deliver(mounted.fork);
    mounted.dispose();
    const [valid] = recordIds(live);
    forgeBroken(live, 'broken-1');
    return { live, valid };
  }

  it('a record that fails the bind check is marked broken and left out of C; valid records are in it', () => {
    const { live, valid } = withValidAndBroken();
    const composite = new Composite(live);
    const built = composite.build();
    try {
      expect(built.broken).toEqual(['broken-1']);
      expect(built.valid).toEqual([valid]);
      expect(exported(built.doc)).toContain('Valid insert.');
      const types = (root(built.doc).toDelta() as { insert: unknown }[]).map((op) => op.insert instanceof Y.XmlText ? op.insert.getAttribute('__type') : null);
      expect(types, 'the broken list item never enters C').not.toContain('listitem');
      expect(exported(live), 'C never writes the body').not.toContain('Valid insert.');
    } finally {
      built.doc.destroy();
    }
  });

  it('Review binds C, and falls back to the body when binding C throws', () => {
    const { live } = withValidAndBroken();
    const shown: string[] = [];
    const good = reviewDoc(live, new Composite(live), (doc) => shown.push(exported(doc)));
    expect(good).toBe('composite');
    expect(shown.at(-1)).toContain('Valid insert.');
    const fallback = reviewDoc(live, new Composite(live), (doc) => {
      if (exported(doc).includes('Valid insert.')) throw new Error('Lexical refused the tree');
      shown.push(exported(doc));
    });
    expect(fallback).toBe('body');
    expect(shown.at(-1)).toBe(exported(live));
  });
});

describe('T5.1 the refusal copy-back @p:mean-2 @p:tech-7 @p:R17', () => {
  it('a record closed under the author offers back every unacked block once, and typing after the remount lands', () => {
    const live = seededBody();
    const link = wire(live);
    const first = mount(live, link);
    first.act(() => select('Hello', 24).insertText(' One.'));
    link.deliver(first.fork);
    const [record] = recordIds(live);
    expect(readMeta(live, record)?.status).toBe('open');
    // Two more edits in two blocks are on the wire when another of the author's windows withdraws the record.
    first.act(() => select('Hello', 29).insertText(' Two.'));
    first.act(() => select('Quoted', 6).insertText(' three'));
    expect(link.outbox.length).toBe(2);
    expect(link.ingest.withdraw({ ...link.who, connection: 'c2' }, record)).toMatchObject({ ok: true });
    link.deliver(first.fork);

    const refusals = first.events.filter((event): event is Extract<ForkEvent, { type: 'refused' }> => event.type === 'refused');
    expect(refusals, 'one refusal for the window').toHaveLength(1);
    expect(refusals[0].reason).toBe('record-closed');
    const unsaved = refusals[0].unsaved.join('\n');
    expect(unsaved).toContain('Two.');
    expect(unsaved).toContain('three');
    expect(first.fork.closed, 'input closes in the same tick').toBe(true);
    const sent = first.fork.sent;
    first.act(() => select('Hello', 0).insertText('Late '));
    expect(first.fork.sent, 'a closed fork sends nothing more').toBe(sent);
    first.dispose();

    const second = mount(live, link);
    try {
      expect(exported(second.fork.doc), 'the rebuilt F leaves the withdrawn record out').not.toContain('One.');
      second.act(() => select('Hello', 24).insertText(' Again.'));
      link.deliver(second.fork);
      const landed = recordIds(live).filter((id) => id !== record);
      expect(landed).toHaveLength(1);
      expect(readMeta(live, landed[0])?.status).toBe('open');
      expect(readRecord(live, landed[0])?.ops.length).toBeGreaterThan(0);
      expect(second.events.some((event) => event.type === 'refused')).toBe(false);
    } finally {
      second.dispose();
    }
  });
});
