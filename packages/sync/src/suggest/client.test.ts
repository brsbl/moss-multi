// T5.1 (docs/design/suggestions.md §5): the client's fork F and composite C, with a real moss editor bound to F the
// way the pane binds it and every request answered by the real ingest. F sends nothing when it binds; every census
// operation is recorded with no refusal; a record that fails the bind check is broken and left out of C, and Review
// falls back to the body when binding C throws; a record closed under the author offers back every unacked block,
// and typing after the remount lands. Payload edits travel per payload doc under the lease and stay proposals.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { $getRoot } from 'lexical';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { SUGGEST_LIMITS, type SuggestReply, type SuggestRequest } from '@moss-multi/protocol/suggest';
import type { RecordMeta } from '@moss-multi/core/suggest/apply';
import { handleSuggest, SuggestIngest } from '../doc/suggest.ts';
import { payloadDocsFor, payloadText } from '../payload-docs.ts';
import { Composite, reviewDoc, SuggestFork, type ForkEvent } from './client.ts';
import { bindEditor } from './fork-shim.ts';
import { createRecord, opsOf, readMeta, readRecord, recordIds, writeSuggestions } from './records.ts';
import { acceptRecord, nodeRegistry, previewRecord } from './review.ts';
import { CENSUS, codeBlock, deterministicIds, EDITOR, exported, insertBlock, LEASED, resetIds, seededBody, select, spansOfText, SUGGESTER, type Step } from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

/** The doc socket between one fork and the DocDO's ingest: requests queue until `deliver` answers them in order. */
function wire(live: Y.Doc, connection = 'c1', ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() })) {
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
function mount(live: Y.Doc, link: ReturnType<typeof wire>, now?: () => number) {
  const events: ForkEvent[] = [];
  const fork = new SuggestFork(live, { me: SUGGESTER.id, name: SUGGESTER.name, send: link.send, now });
  fork.on((event) => events.push(event));
  const bound = bindEditor(fork.doc);
  fork.begin();
  link.deliver(fork);
  // The fill reconciles into Lexical in a collaboration update; commit it before the first input.
  bound.editor.update(() => {}, { discrete: true });
  const act = (step: Step) => {
    // Commit any reconcile of F first: an input batched with a collaboration update would never reach F.
    bound.editor.update(() => {}, { discrete: true });
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
      expect(fork.proposeDelete(targets)).toBeTruthy();
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

  it.each([
    ['new code block', 'new code'],
    ['new HTML block', '<b>new</b>'],
    ['new formula', '3*3'],
    ['an edit of an original code payload', 'seed!'],
  ])('%s: the payload travels as suggest-ops on its own payload doc under the lease, and the body keeps its payloads', (name, text) => {
    const live = seededBody();
    const payloadsBefore = new Map([...payloadDocsFor(live).docs].map(([id, doc]) => [id, payloadText(doc).toString()]));
    const link = wire(live);
    resetIds();
    const { fork, act, dispose } = mount(live, link);
    try {
      for (const step of CENSUS.find((op) => op.name === name)!.steps) act(step);
      link.deliver(fork);
      for (const reply of ops(link)) expect(reply.t).toBe('suggest-ack');
      const [record] = recordIds(live);
      const stored = readRecord(live, record)!.ops.filter((op) => op.doc !== 'body');
      expect(stored.length, 'the record holds a payload op').toBeGreaterThan(0);
      expect(new Set(stored.map((op) => op.doc)).size, 'one payload doc').toBe(1);
      for (const op of stored) expect([...Y.parseUpdateMeta(op.update).from.keys()], 'written under the lease').toEqual([fork.doc.clientID]);
      expect(payloadText(fork.payloads.get(stored[0].doc)!).toString(), "F shows the author's payload").toContain(text);
      for (const [id, before] of payloadsBefore) expect(payloadText(payloadDocsFor(live).get(id)!).toString(), 'a payload edit is a proposal until accept').toBe(before);
      expect(payloadDocsFor(live).get(stored[0].doc)?.getText('payload').toString() ?? '').not.toContain(text);
    } finally {
      dispose();
    }
  });
});

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
    opsOf(live, id).push([{ doc: 'body', update: op }]);
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

  it("C shows a record's edit of an original payload in its payload doc; the body's payload is unchanged", () => {
    const live = seededBody();
    const link = wire(live);
    const mounted = mount(live, link);
    mounted.act(() => codeBlock().setCode('seed!'));
    link.deliver(mounted.fork);
    mounted.dispose();
    const [record] = recordIds(live);
    const id = readRecord(live, record)!.ops.find((op) => op.doc !== 'body')!.doc;
    const built = new Composite(live).build();
    try {
      expect(built.valid).toEqual([record]);
      expect(payloadText(built.payloads.get(id)!).toString(), 'C holds the proposed payload').toBe('seed!');
      expect(payloadText(payloadDocsFor(live).get(id)!).toString(), 'B keeps its payload').toBe('seed');
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

describe('T5.1 copy-back, reconnect and undelete @p:mean-2 @p:tech-7 @p:R17', () => {
  const refusalsOf = (events: ForkEvent[]) => events.filter((event): event is Extract<ForkEvent, { type: 'refused' }> => event.type === 'refused');
  const catchUp = (body: Y.Doc, live: Y.Doc) => Y.applyUpdate(body, Y.encodeStateAsUpdate(live, Y.encodeStateVector(body)));

  it('a refusal that reaches the author before the close update still offers back the refused text', () => {
    const live = seededBody();
    // The author's B is a replica: the record's close reaches it after the refusal.
    const body = new Y.Doc();
    catchUp(body, live);
    const link = wire(live);
    const m = mount(body, link);
    try {
      m.act(() => select('Hello', 24).insertText(' One.'));
      link.deliver(m.fork);
      catchUp(body, live);
      const [record] = recordIds(live);
      expect(link.ingest.withdraw({ ...link.who, connection: 'c2' }, record)).toMatchObject({ ok: true });
      m.act(() => select('Hello', 29).insertText(' Two.'));
      link.deliver(m.fork);
      const refused = refusalsOf(m.events);
      expect(refused, 'one refusal').toHaveLength(1);
      expect(refused[0].reason).toBe('record-closed');
      expect(refused[0].unsaved.join('\n'), "the refused frame's own text is offered back").toContain('Two.');
      expect(m.fork.closed).toBe(true);
      catchUp(body, live);
      expect(refusalsOf(m.events), 'the late close update offers nothing twice').toHaveLength(1);
    } finally {
      m.dispose();
    }
  });

  it('a record closed under the author offers back register edits and new decorator blocks too', () => {
    const live = seededBody();
    const link = wire(live);
    const m = mount(live, link);
    try {
      m.act(() => select('Hello', 24).insertText(' One.'));
      link.deliver(m.fork);
      const [record] = recordIds(live);
      m.act(() => codeBlock().setCode('seed and more'));
      m.act(insertBlock('```moss-chart\n{"type":"bar","data":[{"label":"Monday","value":1}]}\n```'));
      expect(link.outbox.length).toBeGreaterThan(0);
      expect(link.ingest.withdraw({ ...link.who, connection: 'c2' }, record)).toMatchObject({ ok: true });
      link.deliver(m.fork);
      const refused = refusalsOf(m.events);
      expect(refused).toHaveLength(1);
      const unsaved = refused[0].unsaved.join('\n');
      expect(unsaved, 'the edited code register').toContain('seed and more');
      expect(unsaved, 'the new chart block').toContain('Monday');
    } finally {
      m.dispose();
    }
  });

  it('a reconnect after a lost ack resends only what the server never stored, and the active record continues', () => {
    const live = seededBody();
    const link = wire(live);
    const m = mount(live, link);
    try {
      m.act(() => select('Hello', 24).insertText(' One.'));
      // The DocDO stores the frame, and the socket drops before its ack arrives.
      handleSuggest(link.ingest, link.who, link.outbox.shift()!);
      link.ingest.expireConnection('c1');
      link.who.connection = 'c2';
      m.fork.reconnected();
      link.deliver(m.fork);
      expect(refusalsOf(m.events), 'no refusal').toEqual([]);
      expect(link.replies.filter((reply) => reply.t === 'suggest-refused')).toEqual([]);
      expect(m.fork.closed, 'input stays open').toBe(false);
      const [record] = recordIds(live);
      expect(readRecord(live, record)?.ops.length, 'the stored frame is not sent twice').toBe(1);
      m.act(() => select('Hello', 29).insertText(' Two.'));
      link.deliver(m.fork);
      expect(recordIds(live), 'the active record continues').toEqual([record]);
      expect(readRecord(live, record)?.ops.length).toBe(2);
      expect(link.replies.filter((reply) => reply.t === 'suggest-refused')).toEqual([]);
    } finally {
      m.dispose();
    }
  });

  it('a pane left idle past the lease idle limit renews its leases first: the next edit and strike land with no refusal', () => {
    let t = 1_000_000;
    const now = () => t;
    const live = seededBody();
    const link = wire(live, 'c1', new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), now }));
    const m = mount(live, link, now);
    const idle = () => {
      t += SUGGEST_LIMITS.leaseIdleMs + 60_000;
    };
    try {
      // Open, never typed in, for longer than a lease may idle.
      idle();
      m.act(() => select('Hello', 24).insertText(' One.'));
      link.deliver(m.fork);
      // Idle again after an edit: the next group takes the spare, which idled as long.
      idle();
      m.act(() => select('Hello', 29).insertText(' Two.'));
      link.deliver(m.fork);
      idle();
      expect(m.fork.proposeDelete(spansOfText(m.fork.doc, 'world')), 'the strike is proposed').not.toBeNull();
      link.deliver(m.fork);
      expect(link.replies.filter((reply) => reply.t === 'suggest-refused'), 'no frame is refused').toEqual([]);
      expect(refusalsOf(m.events)).toEqual([]);
      expect(m.fork.closed, 'input stays open').toBe(false);
      expect(m.fork.owes).toBe(false);
      const records = recordIds(live).map((id) => readRecord(live, id)!);
      expect(records.reduce((sum, record) => sum + record.ops.length, 0), 'both edits are stored').toBe(2);
      expect(records.flatMap((record) => record.parts), 'the strike is stored').toHaveLength(1);
    } finally {
      m.dispose();
    }
  });

  it('the same fork on a new socket resumes its leases while the DocDO still holds the old socket open; no other connection can', () => {
    const live = seededBody();
    const link = wire(live);
    const m = mount(live, link);
    try {
      m.act(() => select('Hello', 24).insertText(' One.'));
      link.deliver(m.fork);
      const leased = link.replies.find((reply): reply is Extract<SuggestReply, { t: 'suggest-leased' }> => reply.t === 'suggest-leased')!;
      // The socket drops half-open: the DocDO never sees it close. An edit is made offline, then a new socket resumes.
      m.act(() => select('Hello', 29).insertText(' Two.'));
      link.outbox.length = 0;
      // Another connection of the author, without this fork's name, cannot take the leases.
      const stranger = handleSuggest(link.ingest, { ...link.who, connection: 'c3' }, { t: 'suggest-lease', resume: [leased.leases[0].client], fork: 'another-fork-1' });
      expect(stranger).toMatchObject({ t: 'suggest-refused', reason: 'lease' });
      link.who.connection = 'c2';
      m.fork.reconnected();
      link.deliver(m.fork);
      expect(refusalsOf(m.events), 'input stays open').toEqual([]);
      expect(m.fork.closed).toBe(false);
      const [record] = recordIds(live);
      expect(readRecord(live, record)?.ops.length, 'the offline edit lands in the active record').toBe(2);
      expect(m.fork.owes).toBe(false);
      expect(link.replies.filter((reply) => reply.t === 'suggest-refused'), 'the fork itself is never refused').toEqual([]);
    } finally {
      m.dispose();
    }
  });

  it("a second window of the same author resumes only its own leases, never the first window's, and keeps its offline edit", () => {
    const live = seededBody();
    const first = wire(live, 'c1');
    const a = mount(live, first);
    const second = wire(live, 'c2', first.ingest);
    let b: ReturnType<typeof mount> | null = null;
    try {
      a.act(() => select('Hello', 24).insertText(' One.'));
      first.deliver(a.fork);
      // The second window opens after the first wrote: it shows the first window's record.
      b = mount(live, second);
      b.act(() => select('Go to', 0).insertText('Then '));
      second.deliver(b.fork);
      expect(recordIds(live)).toHaveLength(2);
      // The second window's socket drops half-open; an edit is made offline, then a new socket resumes.
      b.act(() => select('Then', 5).insertText('soon '));
      second.outbox.length = 0;
      second.who.connection = 'c3';
      b.fork.reconnected();
      second.deliver(b.fork);
      expect(second.replies.filter((reply) => reply.t === 'suggest-refused'), 'the resume is never refused').toEqual([]);
      expect(refusalsOf(b.events), 'input stays open').toEqual([]);
      expect(b.fork.closed).toBe(false);
      expect(b.fork.owes).toBe(false);
      expect(recordIds(live).map((id) => readRecord(live, id)!.ops.length).sort(), 'the offline edit lands in its own record').toEqual([1, 2]);
      // The first window still writes under its own lease.
      a.act(() => select('Hello', 29).insertText(' Two.'));
      first.deliver(a.fork);
      expect(first.replies.filter((reply) => reply.t === 'suggest-refused'), "the first window's lease was not taken").toEqual([]);
    } finally {
      b?.dispose();
      a.dispose();
    }
  });

  it('every window of the author shows every record of the author live: text and strikes either window makes after both mounted', () => {
    const live = seededBody();
    const first = wire(live, 'c1');
    const a = mount(live, first);
    const second = wire(live, 'c2', first.ingest);
    const b = mount(live, second);
    const text = (m: typeof a) => m.bound.editor.getEditorState().read(() => $getRoot().getTextContent());
    try {
      a.act(() => select('Hello', 24).insertText(' One.'));
      first.deliver(a.fork);
      expect(exported(b.fork.doc), "the second window's F holds the first window's later text").toContain('One.');
      b.act(() => {});
      expect(text(b), "the second window's editor shows it").toContain('One.');
      b.act(() => select('Go to', 0).insertText('Then '));
      second.deliver(b.fork);
      a.act(() => {});
      expect(text(a), "the first window shows the second window's text").toContain('Then Go to');
      const targets = spansOfText(a.fork.doc, 'world');
      const part = a.fork.proposeDelete(targets);
      first.deliver(a.fork);
      expect(b.fork.isStruck(targets[0]), "the second window paints the first window's strike").toBe(true);
      a.fork.withdrawPart(part!);
      first.deliver(a.fork);
      expect(b.fork.isStruck(targets[0]), 'and drops it once it is taken back').toBe(false);
      // Each window keeps writing under its own lease, with no refusal, and the two forks converge.
      b.act(() => select('Then', 5).insertText('soon '));
      second.deliver(b.fork);
      a.act(() => select('First line', 10).insertText(' Two.'));
      first.deliver(a.fork);
      for (const link of [first, second]) expect(link.replies.filter((reply) => reply.t === 'suggest-refused')).toEqual([]);
      expect(refusalsOf(a.events)).toEqual([]);
      expect(refusalsOf(b.events)).toEqual([]);
      expect(exported(a.fork.doc)).toContain('First line Two.');
      expect(exported(b.fork.doc), "the second window shows the first window's next edit").toContain('First line Two.');
      expect(exported(a.fork.doc), 'both windows converge').toBe(exported(b.fork.doc));
    } finally {
      b.dispose();
      a.dispose();
    }
  });

  it('a merged record keeps its strikes: they move with the merge, paint struck, and undo takes them back from the merged record', () => {
    const live = seededBody();
    const link = wire(live);
    let clock = 1_000_000;
    const m = mount(live, link, () => clock);
    try {
      m.act(() => select('Hello', 24).insertText(' One.'));
      const targets = spansOfText(m.fork.doc, 'world');
      const part = m.fork.proposeDelete(targets);
      link.deliver(m.fork);
      const [first] = recordIds(live);
      expect(readRecord(live, first)?.parts.map((p) => p.quote)).toEqual(['world']);
      // A new group after the idle gap, built on the first group's text: the first record merges into the second.
      clock += 31_000;
      m.act(() => select('Hello', 29).insertText(' Two.'));
      link.deliver(m.fork);
      expect(link.replies.filter((reply) => reply.t === 'suggest-refused')).toEqual([]);
      expect(readMeta(live, first)?.mergedInto, 'the first record merged').toBeTruthy();
      const into = readMeta(live, first)!.mergedInto!;
      expect(readRecord(live, into)?.parts.map((p) => p.quote), 'the server keeps the delete pending').toEqual(['world']);
      expect(m.fork.isStruck(targets[0]), 'the author still sees it struck').toBe(true);
      expect(m.fork.withdrawPart(String(part)), 'undo reaches the merged record').toBe(true);
      link.deliver(m.fork);
      expect(link.replies.filter((reply) => reply.t === 'suggest-refused')).toEqual([]);
      expect(readRecord(live, into)?.parts, 'suggest-undelete took it back from the merged record').toEqual([]);
      expect(m.fork.isStruck(targets[0])).toBe(false);
    } finally {
      m.dispose();
    }
  });

  it('taking back a delete part removes it from the record, and the text is no longer struck', () => {
    const live = seededBody();
    const link = wire(live);
    const m = mount(live, link);
    try {
      const targets = spansOfText(m.fork.doc, 'world');
      const part = m.fork.proposeDelete(targets);
      link.deliver(m.fork);
      expect(typeof part, 'the part id').toBe('string');
      const [record] = recordIds(live);
      expect(readRecord(live, record)?.parts).toHaveLength(1);
      expect(m.fork.withdrawPart(String(part))).toBe(true);
      link.deliver(m.fork);
      expect(readRecord(live, record)?.parts, 'suggest-undelete took it back').toEqual([]);
      expect(m.fork.isStruck(targets[0])).toBe(false);
      expect(link.replies.filter((reply) => reply.t === 'suggest-refused')).toEqual([]);
    } finally {
      m.dispose();
    }
  });
});

describe('T5.1 an accept seen during a reconnect @p:mean-2 @p:tech-7 @p:R17', () => {
  it('offline text in a record an editor accepted meanwhile resumes its lease and lands as a continuation, never copy-back', () => {
    const live = seededBody();
    const link = wire(live);
    const m = mount(live, link);
    try {
      m.act(() => select('Hello', 24).insertText(' One.'));
      link.deliver(m.fork);
      const [record] = recordIds(live);
      // Typed while the socket is down: the frame is lost with it.
      m.act(() => select('Hello', 29).insertText(' Two.'));
      link.outbox.length = 0;
      link.ingest.expireConnection('c1');
      // An editor accepts the record meanwhile; the author's B learns of it before the fork resumes.
      const preview = previewRecord(live, record);
      if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
      expect(acceptRecord(live, record, { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
      link.outbox.length = 0;
      link.who.connection = 'c2';
      m.fork.reconnected();
      link.deliver(m.fork);
      expect(link.replies.filter((reply) => reply.t === 'suggest-refused'), 'nothing is refused').toEqual([]);
      expect(m.events.filter((event) => event.type === 'refused'), 'nothing is offered back').toEqual([]);
      expect(m.fork.closed, 'input stays open').toBe(false);
      expect(m.fork.owes).toBe(false);
      const continuation = recordIds(live).map((id) => readMeta(live, id)!).find((meta) => meta.continues === record);
      expect(continuation?.status, 'the offline text opens a continuation of the accepted record').toBe('open');
      expect(readRecord(live, continuation!.id)?.ops.length).toBe(1);
      expect(exported(live), 'the accepted text is in the body').toContain('One.');
    } finally {
      m.dispose();
    }
  });
});
