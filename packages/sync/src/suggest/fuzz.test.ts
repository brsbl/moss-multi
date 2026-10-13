// T5.4 (docs/design/suggestions.md §9): an adversarial struct-level fuzz over records built from a real fork's frames,
// run against the DocDO's ingest and accept and against the client's F and C builds, and a generative honest-edit fuzz
// through real moss editors in suggest mode. Every failure names its seed, so a case replays alone.
import { $insertTableRowAtNode, $isTableCellNode } from '@lexical/table';
import { $isListItemNode } from '@lexical/list';
import { $createRangeSelection, $getRoot, $isTextNode, $parseSerializedNode, $setSelection, type SerializedLexicalNode, type TextNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import {
  canonical, deleteUpdate, hydrate, previewHash, projectDoc, projectionDiff, recordDigest, type DeletePart, type RecordMeta, type RecordOp,
} from '@moss-multi/core/suggest/apply';
import { importMarkdown } from '../converter/index.ts';
import { handleSuggest, SuggestIngest, type IngestResult } from '../doc/suggest.ts';
import { attachPayloadDocs, PayloadDocs, payloadDocsFor } from '../payload-docs.ts';
import { payloadSourceOf } from '../server-doc.ts';
import { Composite, destroyView, reviewDoc, SuggestFork } from './client.ts';
import { bindEditor, ForkShim } from './fork-shim.ts';
import { decodeFrame, encodeFrame, int, mutateOp, mutateRecord, pick, rng, targetsOf, type Targets } from './fuzz-support.ts';
import { createRecord, newSuggestionsClient, opsOf, partsOf, readMeta, readRecord, recordIds, suggestionsWriter, SuggestionsWriter, writeSuggestions } from './records.ts';
import { acceptRecord, nodeRegistry, previewRecord } from './review.ts';
import {
  all, CENSUS, changedRoots, type CensusOp, deterministicIds, directEdit, EDITOR, exported, LEASED, opOn, OTHER_SUGGESTER, payloadsInOrder, resetIds, seededBody,
  spansOfText, SUGGESTER, type Step,
} from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

const PEER_LEASED = 0x7fff4321;
const FOREIGN = [0x6fff0001, 0x6fff0002];
const FUZZ_ID = 'fuzzed';
const PEER_ID = 'peer';

/** Seeds per test; FUZZ_SEED replays one. */
const seedsFrom = (base: number, count: number): number[] =>
  process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: count }, (_, i) => base + i);

function forge(live: Y.Doc, id: string, author: { id: string; name: string }, clients: number[], ops: RecordOp[], parts: DeletePart[], createdAt: number): void {
  const meta: RecordMeta = { v: 2, id, author: author.id, authorName: author.name, source: 'live', createdAt, updatedAt: createdAt, status: 'open', clients };
  writeSuggestions(live, () => {
    createRecord(live, meta);
    opsOf(live, id).push(ops);
    partsOf(live, id).push(parts);
  });
}

/** A fork's real frames for one census operation under `lease`, copied out. */
function honestOps(live: Y.Doc, lease: number, op: CensusOp): RecordOp[] {
  const fork = new ForkShim(live, lease);
  try {
    for (const step of op.steps) {
      if (step === 'undo') fork.undo();
      else fork.act(step);
    }
    return fork.sent.map((sent) => ({ doc: sent.doc, update: sent.update.slice() }));
  } finally {
    fork.dispose();
  }
}

interface Case {
  seed: number;
  live: Y.Doc;
  writer: number;
  record: { ops: RecordOp[]; clients: number[]; parts: DeletePart[] };
  story: string[];
  /** The note (body and payloads) before the forged record, for the ingest leg's own copy. */
  base: Note;
  /** Every payload id a view may read: the note's, the targets' and the record's. */
  payloadIds: string[];
  /** C's canonical view with the peer's record alone, read before the forged record exists. */
  peerOnly: string;
}

interface Note {
  state: Uint8Array;
  payloads: Map<string, Uint8Array>;
}

const noteOf = (live: Y.Doc): Note => ({
  state: Y.encodeStateAsUpdate(live),
  payloads: new Map([...payloadDocsFor(live).docs].map(([id, doc]) => [id, Y.encodeStateAsUpdate(doc)])),
});

function copyNote({ state, payloads }: Note): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const host = payloadDocsFor(doc);
  for (const [id, update] of payloads) Y.applyUpdate(host.hold(id), update);
  return doc;
}

/** Seed `seed`'s forged record over `live`: a census operation's real frames under `lease`, then the seed's mutations. */
function forgedRecord(seed: number, live: Y.Doc, lease: number) {
  const random = rng(seed);
  const census = pick(random, CENSUS);
  const ops = honestOps(live, lease, census);
  const targets: Targets = targetsOf(live, payloadDocsFor(live).docs, FOREIGN);
  const clients = [lease];
  const parts: DeletePart[] = [];
  const story = [`census: ${census.name}`];
  // One case in five stays honest, so accept's landing leg runs too.
  const mutations = random() < 0.2 ? 0 : 1 + int(random, 3);
  for (let n = mutations; n > 0; n -= 1) {
    story.push(random() < 0.75 ? mutateOp(random, ops, lease, targets) : mutateRecord(random, ops, clients, parts, targets));
  }
  return { ops, clients, parts, story, honest: mutations === 0, targets };
}

/** A seeded body with a writer under S, a peer's honest record, and a forged record built from a fork's real frames. */
function fuzzCase(seed: number): Case {
  const live = seededBody();
  const writer = newSuggestionsClient(live);
  new SuggestionsWriter(live, writer);
  forge(live, PEER_ID, OTHER_SUGGESTER, [PEER_LEASED], honestOps(live, PEER_LEASED, CENSUS.find((op) => op.name === 'a duplicated word')!), [], 1);
  const base = noteOf(live);
  const { ops, clients, parts, story, targets } = forgedRecord(seed, live, LEASED);
  const payloadIds = [...new Set([...payloadDocsFor(live).docs.keys(), ...targets.payloadIds, ...ops.map((op) => op.doc).filter((doc) => doc !== 'body')])].sort();
  const peer = new Composite(live).build();
  const peerOnly = cView(peer.doc, writer, payloadSourceOf(peer.doc).read, payloadIds);
  destroyView(peer);
  forge(live, FUZZ_ID, SUGGESTER, clients, ops, parts, 2);
  return { seed, live, writer, record: { ops, clients, parts }, story, base, payloadIds, peerOnly };
}

const contentOf = (item: Y.Item, at: number): unknown => {
  const content = item.content;
  if (content instanceof Y.ContentString) return ['s', content.str[at]];
  if (content instanceof Y.ContentType) return ['t', content.type instanceof Y.XmlElement ? `element:${content.type.nodeName}` : content.type.constructor.name];
  if (content instanceof Y.ContentFormat) return ['f', content.key, content.value];
  if (content instanceof Y.ContentBinary) return ['b', Array.from(content.content)];
  if (content instanceof Y.ContentDoc) return ['d', content.doc?.guid ?? null];
  return ['v', content.getContent()[at] ?? null];
};

/**
 * Every unit of `doc` outside `suggestions`, one per clock, however Yjs split or merged its structs: a live unit with
 * its root, parent, key and content, a deleted one (the delete set) by id alone. The writer's are suggestion
 * bookkeeping, left out.
 */
function unitsOf(doc: Y.Doc, writer: number | null): unknown[] {
  const names = new Map<unknown, string>([...doc.share].map(([name, type]) => [type, name]));
  const units: unknown[] = [];
  for (const [client, structs] of [...doc.store.clients].sort(([a], [b]) => a - b)) {
    if (client === writer) continue;
    for (const struct of structs) {
      if (!(struct instanceof Y.Item) || struct.deleted) {
        for (let at = 0; at < struct.length; at += 1) units.push([client, struct.id.clock + at, 'deleted']);
        continue;
      }
      let top = struct.parent as Y.AbstractType<unknown> | null;
      while (top?._item) top = top._item.parent as Y.AbstractType<unknown>;
      const root = names.get(top) ?? '?';
      if (root === 'suggestions') continue;
      const parent = (struct.parent as Y.AbstractType<unknown> | null)?._item?.id;
      for (let at = 0; at < struct.length; at += 1) {
        units.push([client, struct.id.clock + at, root, parent ? `${parent.client}:${parent.clock}` : null, struct.parentSub, contentOf(struct, at)]);
      }
    }
  }
  return units;
}

/**
 * A view as a canonical string, all but suggestion bookkeeping: every root's units with the delete set, and each
 * payload in `ids` as `read` returns it (an empty payload reads as absent).
 */
function viewOf(doc: Y.Doc, writer: number, read: (id: string) => Uint8Array | null, ids: readonly string[]): string {
  const payloads = ids.map((id) => {
    const state = read(id);
    if (!state) return [id, null];
    const copy = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(copy, state);
      const units = unitsOf(copy, null);
      return [id, units.length ? units : null];
    } finally {
      copy.destroy();
    }
  });
  return canonical({ units: unitsOf(doc, writer), payloads });
}

/** The oracles: F with a record left out is the body; C with one left out is C without it. */
const fView = viewOf;
const cView = viewOf;

const readFrom = (host: (id: string) => Y.Doc | undefined) => (id: string): Uint8Array | null => {
  const doc = host(id);
  return doc ? Y.encodeStateAsUpdate(doc) : null;
};

/** Everything but the records: the note's state vector and delete set without S's, and every payload doc's bytes. */
function snapshot(live: Y.Doc, writer: number): string {
  const sv = [...Y.decodeStateVector(Y.encodeStateVector(live))].filter(([client]) => client !== writer).sort(([a], [b]) => a - b);
  const ds = [...(Y.createDeleteSetFromStructStore(live.store) as unknown as { clients: Map<number, { clock: number; len: number }[]> }).clients]
    .filter(([client]) => client !== writer)
    .sort(([a], [b]) => a - b)
    .map(([client, ranges]) => [client, ranges.map(({ clock, len }) => [clock, len])]);
  const payloads = [...payloadDocsFor(live).docs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, doc]) => [id, Array.from(Y.encodeStateAsUpdate(doc))]);
  return canonical({ sv, ds, payloads });
}

/** A gc-free copy of payload `id` as the note stores it, its roots typed first; empty for an id it lacks. */
function payloadCopy(live: Y.Doc, id: string): Y.Doc {
  const doc = new Y.Doc({ gc: false, guid: id });
  doc.getText('payload');
  doc.getMap('payload-map');
  const state = payloadSourceOf(live).read(id);
  if (state) Y.applyUpdate(doc, state);
  return doc;
}

function projectLive(live: Y.Doc, also: string[]) {
  const copies = new Map<string, Y.Doc>();
  const body = hydrate(live);
  try {
    return projectDoc(body, (id) => {
      if (!copies.has(id)) copies.set(id, payloadCopy(live, id));
      return copies.get(id);
    }, also);
  } finally {
    body.destroy();
    for (const doc of copies.values()) doc.destroy();
  }
}

const advanced = (before: Map<number, number>, after: Map<number, number>) => [...after].filter(([client, clock]) => clock > (before.get(client) ?? 0)).map(([client]) => client);

/**
 * The server leg: accept either refuses with nothing applied, or lands exactly the hashed preview, touching only the
 * body's root and the payloads the record writes, and only the record's leased clients. Neither may throw.
 */
function serverLeg({ live, writer, record }: Case): string[] {
  const problems: string[] = [];
  const stored = readRecord(live, FUZZ_ID)!;
  const payloadIds = [...new Set(stored.ops.map((op) => op.doc).filter((doc) => doc !== 'body'))];
  const before = snapshot(live, writer);
  const projected = projectLive(live, []);
  const svBefore = Y.decodeStateVector(Y.encodeStateVector(live));
  const payloadSvs = new Map([...payloadDocsFor(live).docs].map(([id, doc]) => [id, Y.decodeStateVector(Y.encodeStateVector(doc))]));
  let preview: ReturnType<typeof previewRecord>;
  try {
    preview = previewRecord(live, FUZZ_ID);
  } catch (error) {
    return [`preview threw: ${(error as Error).message}`];
  }
  const watch = changedRoots(live);
  let result: ReturnType<typeof acceptRecord>;
  try {
    result = acceptRecord(live, FUZZ_ID, { previewHash: preview.ok ? preview.hash : 'none', digest: recordDigest(stored) }, EDITOR);
  } catch (error) {
    return [`accept threw: ${(error as Error).message}`];
  } finally {
    watch.stop();
  }
  if (!result.ok) {
    if (snapshot(live, writer) !== before) problems.push(`refused ${result.reason}, but the note or a payload changed`);
    if (readMeta(live, FUZZ_ID)?.status !== 'open') problems.push('refused, but the record closed');
    return problems;
  }
  if (!preview.ok) problems.push(`accepted, though the preview refused ${preview.reason}`);
  const hash = previewHash(projectionDiff(projected, projectLive(live, payloadIds)));
  if (preview.ok && hash !== preview.hash) problems.push('accepted, but what landed differs from the hashed preview');
  const roots = [...watch.roots].filter((name) => name !== 'suggestions' && name !== 'root');
  if (roots.length) problems.push(`accept changed ${roots.join(', ')}`);
  const clients = new Set(record.clients);
  const strangers = advanced(svBefore, Y.decodeStateVector(Y.encodeStateVector(live))).filter((client) => client !== writer && !clients.has(client));
  if (strangers.length) problems.push(`accept landed structs of unleased clients ${strangers.join(', ')}`);
  for (const [id, doc] of payloadDocsFor(live).docs) {
    if (!payloadIds.includes(id)) {
      if (payloadSvs.has(id) && advanced(payloadSvs.get(id)!, Y.decodeStateVector(Y.encodeStateVector(doc))).length) problems.push(`accept wrote payload ${id}, which the record does not`);
      continue;
    }
    const foreign = advanced(payloadSvs.get(id) ?? new Map(), Y.decodeStateVector(Y.encodeStateVector(doc))).filter((client) => !clients.has(client));
    if (foreign.length) problems.push(`payload ${id} holds structs of unleased clients ${foreign.join(', ')}`);
    for (const [name, type] of doc.share) {
      if (name !== 'payload' && name !== 'payload-map' && (type._start !== null || type._map.size > 0)) problems.push(`payload ${id} holds root ${name}`);
    }
  }
  return problems;
}

/** The doc socket between one fork and the ingest, answered in order. */
function wire(live: Y.Doc, mint: () => string) {
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: mint });
  const outbox: SuggestRequest[] = [];
  const replies: SuggestReply[] = [];
  const who = { ...SUGGESTER, role: 'suggester', connection: 'fuzz' };
  return {
    replies,
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

/** A suggester's fork with a moss editor bound to F before it fills, as the pane binds it. */
function mount(live: Y.Doc, link: ReturnType<typeof wire>) {
  const fork = new SuggestFork(live, { me: SUGGESTER.id, name: SUGGESTER.name, send: link.send, now: () => 1_000 });
  const bound = bindEditor(fork.doc);
  const dispose = () => {
    bound.dispose();
    fork.dispose();
  };
  try {
    fork.begin();
    link.deliver(fork);
    bound.editor.update(() => {}, { discrete: true });
  } catch (error) {
    dispose();
    throw error;
  }
  const act = (step: Step) => {
    bound.editor.update(() => {}, { discrete: true });
    if (step === 'undo') bound.undo.undo();
    else bound.editor.update(step, { discrete: true });
    bound.editor.update(() => {}, { discrete: true });
  };
  return { fork, act, dispose };
}

/**
 * The client leg on the same forged record: the ingest loads it, C and F build, and Review binds C, with no throw
 * escaping; a record either build marks broken is left out of it, so C is the peer's record alone and F is the body.
 */
function clientLeg({ live, writer, payloadIds, peerOnly }: Case): string[] {
  const problems: string[] = [];
  let built: ReturnType<Composite['build']>;
  try {
    built = new Composite(live).build();
  } catch (error) {
    return [`C threw: ${(error as Error).message}`];
  }
  try {
    if (!built.valid.includes(PEER_ID)) problems.push("the peer's honest record left C");
    if (built.broken.includes(FUZZ_ID) && cView(built.doc, writer, payloadSourceOf(built.doc).read, payloadIds) !== peerOnly) {
      problems.push('C is broken-excluded, yet differs from C with the peer record alone');
    }
  } finally {
    destroyView(built);
  }
  try {
    reviewDoc(live, new Composite(live), (doc) => {
      // As the pane mounts it: an editor bound to an empty doc with the view's payloads, then the view's state synced in.
      const target = new Y.Doc();
      const source = payloadSourceOf(doc);
      attachPayloadDocs(target, new PayloadDocs((id) => source.read(id), (id) => source.has(id)));
      const bound = bindEditor(target);
      try {
        Y.applyUpdate(target, Y.encodeStateAsUpdate(doc));
        bound.editor.update(() => {}, { discrete: true });
      } finally {
        bound.dispose();
        payloadDocsFor(target).destroy();
        target.destroy();
      }
    });
  } catch (error) {
    problems.push(`Review threw: ${(error as Error).message}`);
  }
  let own: ReturnType<Composite['build']>;
  try {
    own = new Composite(live, { author: SUGGESTER.id }).build();
  } catch (error) {
    return [...problems, `the author's C threw: ${(error as Error).message}`];
  }
  const excluded = own.broken.includes(FUZZ_ID);
  own.doc.destroy();
  let mounted: ReturnType<typeof mount>;
  try {
    let n = 0;
    mounted = mount(live, wire(live, () => `lease-${(n += 1)}`));
  } catch (error) {
    return [...problems, `F threw: ${(error as Error).message}`];
  }
  try {
    if (!mounted.fork.ready) problems.push('F never filled');
    if (excluded && fViewOf(mounted.fork, live, writer, payloadIds) !== bodyView(live, writer, payloadIds)) problems.push('F holds content of a record its build marked broken');
  } finally {
    mounted.dispose();
  }
  return problems;
}

/** F as the oracle reads it: its doc, and each payload it holds, else the body's. */
const fViewOf = (fork: SuggestFork, live: Y.Doc, writer: number, ids: readonly string[], doc: Y.Doc = fork.doc) =>
  fView(doc, writer, readFrom((id) => fork.payloads.get(id) ?? payloadDocsFor(live).get(id)), ids);
const bodyView = (live: Y.Doc, writer: number, ids: readonly string[]) => fView(live, writer, readFrom((id) => payloadDocsFor(live).get(id)), ids);

/** Everything ingest holds: the doc's state (its records included) and every payload's. */
const heldBy = (doc: Y.Doc) => canonical({ doc: Array.from(Y.encodeStateAsUpdate(doc)), payloads: [...payloadDocsFor(doc).docs].map(([id, payload]) => [id, Array.from(Y.encodeStateAsUpdate(payload))]) });

interface IngestRun {
  results: IngestResult[];
  /** Ops the leased record holds after the run. */
  stored: number;
  problems: string[];
}

/**
 * Ingest of `build`'s ops, as the author's `suggest-ops` on a copy of the note, under the lease the ingest grants.
 * Each op is stored (the record grows by one) or refused with nothing held changed; none throws.
 */
function ingestRun(base: Note, build: (doc: Y.Doc, lease: number) => RecordOp[]): IngestRun {
  const doc = copyNote(base);
  const problems: string[] = [];
  const results: IngestResult[] = [];
  try {
    const ingest = new SuggestIngest(doc, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), mintId: () => 'ingested' });
    const who = { ...SUGGESTER, role: 'suggester', connection: 'ingest' };
    const leased = ingest.lease(who, [], 1);
    if (!leased.ok) return { results, stored: 0, problems: [`lease refused: ${leased.reason}`] };
    const [grant] = leased.leases;
    const stored = () => readRecord(doc, grant.record)?.ops.length ?? 0;
    for (const op of build(doc, grant.client)) {
      const before = heldBy(doc);
      const count = stored();
      const result = ingest.ops(who, grant.record, op);
      results.push(result);
      if (result.ok && stored() !== count + 1) problems.push('an admitted op was not appended to the record');
      if (!result.ok && heldBy(doc) !== before) problems.push(`refused ${result.reason}, yet the doc or a payload changed`);
    }
    return { results, stored: stored(), problems };
  } catch (error) {
    return { results, stored: 0, problems: [...problems, `ingest threw: ${(error as Error).message}`] };
  } finally {
    payloadDocsFor(doc).destroy();
    doc.destroy();
  }
}

const reasons = (run: IngestRun) => run.results.flatMap((result) => (result.ok ? [] : [result.reason]));

/**
 * The fuzz's ingest leg: the seed's record rebuilt under the lease ingest grants. An honest case is admitted whole;
 * a forged one is refused past the lease gate unless it forged a client.
 */
function ingestLeg({ seed, base }: Case): string[] {
  const seen = { story: [] as string[], honest: false };
  const run = ingestRun(base, (doc, lease) => {
    const forged = forgedRecord(seed, doc, lease);
    seen.story = forged.story;
    seen.honest = forged.honest;
    return forged.ops;
  });
  const { story, honest } = seen;
  const problems = [...run.problems];
  if (honest && (reasons(run).length || run.stored !== run.results.length)) problems.push(`an honest record was refused: ${reasons(run).join(', ')}`);
  if (reasons(run).includes('lease') && !story.some((step) => step.startsWith('use a client the record does not lease'))) {
    problems.push('refused at the lease gate, though built under the granted lease');
  }
  return problems.map((problem) => `ingest: ${problem}`);
}

describe('T5.4 struct-level fuzz over records built from real peer frames @p:mean-2 @p:R17', () => {
  it.each([0, 1, 2, 3, 4, 5])('accept refuses with nothing applied or lands exactly the hashed preview (batch %i)', (batch) => {
    const failures: string[] = [];
    const seen = new Map<string, number>();
    for (const seed of seedsFrom(1_000 + batch * 25, 25)) {
      const fuzz = fuzzCase(seed);
      try {
        const problems = [...ingestLeg(fuzz), ...serverLeg(fuzz)];
        const outcome = readMeta(fuzz.live, FUZZ_ID)?.status === 'accepted' ? 'accepted' : 'refused';
        seen.set(outcome, (seen.get(outcome) ?? 0) + 1);
        for (const problem of problems) failures.push(`seed ${seed} [${fuzz.story.join('; ')}]: ${problem}`);
      } finally {
        payloadDocsFor(fuzz.live).destroy();
        fuzz.live.destroy();
      }
    }
    console.log(`T5.4 fuzz batch ${batch}: ${[...seen].map(([k, v]) => `${v} ${k}`).join(', ')}`);
    expect(failures).toEqual([]);
  }, 120_000);
});

describe("T5.4 the same fuzz on the client's F and C builds @p:mean-2 @p:R17", () => {
  it.each([0, 1, 2, 3])('no throw escapes, and a broken record is left out of F and C (batch %i)', (batch) => {
    const failures: string[] = [];
    for (const seed of seedsFrom(5_000 + batch * 15, 15)) {
      const fuzz = fuzzCase(seed);
      try {
        for (const problem of clientLeg(fuzz)) failures.push(`seed ${seed} [${fuzz.story.join('; ')}]: ${problem}`);
      } finally {
        payloadDocsFor(fuzz.live).destroy();
        fuzz.live.destroy();
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('T5.4 fuzz findings, each replayed as a fixed case @p:mean-2 @p:R17', () => {
  function excludedEverywhere(live: Y.Doc, id: string, writer: number): void {
    const ids = [...new Set([...payloadDocsFor(live).docs.keys(), ...readRecord(live, id)!.ops.map((op) => op.doc).filter((doc) => doc !== 'body')])].sort();
    const built = new Composite(live).build();
    try {
      expect(built.broken, 'C leaves the record out').toEqual([id]);
      expect(cView(built.doc, writer, payloadSourceOf(built.doc).read, ids), 'C is the body').toBe(bodyView(live, writer, ids));
    } finally {
      destroyView(built);
    }
    let n = 0;
    const mounted = mount(live, wire(live, () => `lease-${(n += 1)}`));
    try {
      expect(mounted.fork.ready, 'F fills without the record').toBe(true);
      expect(fViewOf(mounted.fork, live, writer, ids), 'F is the body').toBe(bodyView(live, writer, ids));
    } finally {
      mounted.dispose();
    }
  }

  it("seed 5023: a record that deletes a block's __type is broken; an editor showing the block would throw, and hydration only skips it", () => {
    const live = seededBody();
    const writer = newSuggestionsClient(live);
    new SuggestionsWriter(live, writer);
    const op = opOn(live, 'body', (doc) => {
      const hello = (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((d) => d.insert).find((x) => x instanceof Y.XmlText) as Y.XmlText;
      hello.removeAttribute('__type');
    });
    forge(live, FUZZ_ID, SUGGESTER, [LEASED], [op], [], 2);
    excludedEverywhere(live, FUZZ_ID, writer);
    const before = snapshot(live, writer);
    const record = readRecord(live, FUZZ_ID)!;
    expect(previewRecord(live, FUZZ_ID)).toMatchObject({ ok: false, reason: 'broken' });
    expect(acceptRecord(live, FUZZ_ID, { previewHash: 'none', digest: recordDigest(record) }, EDITOR)).toEqual({ ok: false, status: 409, reason: 'broken' });
    expect(snapshot(live, writer)).toBe(before);
  });

  it("seed 5014: a record whose chart payload no editor can decode is broken for F and C, which bind the record's payloads", () => {
    const live = seededBody();
    let n = 0;
    const link = wire(live, () => (n++ === 0 ? 'chart' : `spare-${n}`));
    const mounted = mount(live, link);
    mounted.act(CENSUS.find((op) => op.name === 'new chart block')!.steps[0] as () => void);
    link.deliver(mounted.fork);
    mounted.dispose();
    const record = readRecord(live, 'chart')!;
    const payload = record.ops.find((op) => op.doc !== 'body')!.doc;
    // The record's own payload, then one more write under its lease: a key list the chart codec reads as an array,
    // holding a number.
    const held = new Y.Doc({ gc: false });
    for (const op of record.ops) if (op.doc === payload) Y.applyUpdate(held, op.update);
    held.clientID = record.meta.clients[0];
    let update: Uint8Array = new Uint8Array();
    held.on('update', (made: Uint8Array) => {
      update = made;
    });
    held.getMap('payload-map').set('#k', 5);
    held.destroy();
    writeSuggestions(live, () => opsOf(live, 'chart').push([{ doc: payload, update }]));
    excludedEverywhere(live, 'chart', suggestionsWriter(live)?.client ?? -1);
  });
});

describe('T5.B5 the ingest leg builds under the lease ingest grants and reaches placement @p:mean-2 @p:R17', () => {
  const baseNote = (): Note => {
    const live = seededBody();
    new SuggestionsWriter(live, newSuggestionsClient(live));
    return noteOf(live);
  };
  const census = (name: string) => CENSUS.find((op) => op.name === name)!;

  it.each(CENSUS.map((op) => op.name))('an unmutated census case is admitted and appended: %s', (name) => {
    const run = ingestRun(baseNote(), (doc, lease) => honestOps(doc, lease, census(name)));
    expect(run.problems).toEqual([]);
    expect(reasons(run)).toEqual([]);
    expect(run.results.length).toBeGreaterThan(0);
    expect(run.stored, 'every op appended to the record').toBe(run.results.length);
  });

  it('a frame under the granted client that writes outside the body is refused by placement, nothing held changed', () => {
    const run = ingestRun(baseNote(), (doc, lease) => {
      const ops = honestOps(doc, lease, census('a duplicated word'));
      const last = ops[ops.length - 1];
      const frame = decodeFrame(last.update);
      const next = Math.max(...frame.structs.filter((struct) => struct.id.client === lease).map((struct) => struct.id.clock + struct.length));
      frame.structs.push(new Y.Item(Y.createID(lease, next), null, null, null, null, 'title' as never, null, new Y.ContentString('forged')));
      last.update = encodeFrame(frame);
      return ops;
    });
    expect(run.problems).toEqual([]);
    expect(reasons(run)).toEqual(['channel']);
    expect(run.stored).toBe(run.results.length - 1);
  });

  it('negative control: the same frames under a client ingest never granted are refused at the lease gate', () => {
    const run = ingestRun(baseNote(), (doc) => honestOps(doc, LEASED, census('a duplicated word')));
    expect(run.problems).toEqual([]);
    expect(run.results.length).toBeGreaterThan(0);
    expect(new Set(reasons(run))).toEqual(new Set(['lease']));
    expect(run.stored).toBe(0);
  });
});

describe('T5.B5 the F and C oracles read deletes, every root and every payload @p:mean-2 @p:R17', () => {
  const rootValue = (doc: Y.Doc) => canonical(doc.get('root', Y.XmlText).toJSON());
  const svOf = (doc: Y.Doc) => canonical([...Y.decodeStateVector(Y.encodeStateVector(doc))].sort(([a], [b]) => a - b));

  /** A note whose one open record is broken: it deletes a block's __type, and (with `payload`) edits the code block. */
  function brokenNote(payload: boolean) {
    const live = seededBody();
    const writer = newSuggestionsClient(live);
    new SuggestionsWriter(live, writer);
    const key = [...payloadDocsFor(live).docs].find(([, doc]) => doc.getText('payload').toString() === 'seed')![0];
    const ops = [opOn(live, 'body', (doc) => {
      const hello = (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((d) => d.insert).find((x) => x instanceof Y.XmlText) as Y.XmlText;
      hello.removeAttribute('__type');
    })];
    const leaks: Uint8Array[] = [];
    if (payload) {
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(payloadDocsFor(live).get(key)!));
      copy.clientID = LEASED;
      copy.on('update', (update: Uint8Array) => leaks.push(update));
      copy.getText('payload').insert(0, 'LEAK ');
      copy.destroy();
      ops.push({ doc: key, update: leaks[0] });
    }
    forge(live, FUZZ_ID, SUGGESTER, [LEASED], ops, [], 2);
    return { live, writer, key, leak: leaks[0] ?? null, ids: [...payloadDocsFor(live).docs.keys()].sort() };
  }

  it('an F that leaked only a body deletion of a record it left out is caught; its state vector is unchanged', () => {
    const { live, writer, ids } = brokenNote(false);
    let n = 0;
    const mounted = mount(live, wire(live, () => `lease-${(n += 1)}`));
    const leaked = new Y.Doc();
    try {
      expect(fViewOf(mounted.fork, live, writer, ids), 'the honest F is the body').toBe(bodyView(live, writer, ids));
      Y.applyUpdate(leaked, Y.encodeStateAsUpdate(mounted.fork.doc));
      Y.applyUpdate(leaked, deleteUpdate(spansOfText(live, 'world')));
      expect(svOf(leaked), 'the state-vector check misses it').toBe(svOf(live));
      expect(fViewOf(mounted.fork, live, writer, ids, leaked), 'the oracle catches it').not.toBe(bodyView(live, writer, ids));
    } finally {
      leaked.destroy();
      mounted.dispose();
    }
  });

  it('a C that leaked only a payload edit of a record it left out is caught; its root value is unchanged', () => {
    const { live, writer, key, leak, ids } = brokenNote(true);
    const built = new Composite(live).build();
    try {
      expect(built.broken).toEqual([FUZZ_ID]);
      const read = payloadSourceOf(built.doc).read;
      expect(cView(built.doc, writer, read, ids), 'the honest C is the body').toBe(bodyView(live, writer, ids));
      const leaked = (id: string) => (id === key ? Y.mergeUpdates([read(id)!, leak!]) : read(id));
      expect(rootValue(built.doc), 'the root-value check misses it').toBe(rootValue(live));
      expect(cView(built.doc, writer, leaked, ids), 'the oracle catches it').not.toBe(bodyView(live, writer, ids));
    } finally {
      destroyView(built);
    }
  });
});

describe('T5.3s a strike, then a native delete of the struck text, is one honest record @p:mean-2 @p:R17', () => {
  it("Backspace strikes a block's first character, then Backspace at the block's start joins it: previewed and accepted", () => {
    const live = seededBody('Intro line stays.\n\nabc tail.\n\nClosing line stays too.\n');
    let n = 0;
    const link = wire(live, () => `r${(n += 1)}`);
    const mounted = mount(live, link);
    try {
      // Backspace after "a": the routing strikes it with a delete part, and the "a" stays live in F.
      const [run] = spansOfText(mounted.fork.doc, 'abc');
      expect(mounted.fork.proposeDelete([{ client: run.client, clock: run.clock, len: 1 }]), 'the strike is proposed').not.toBeNull();
      link.deliver(mounted.fork);
      // Backspace again, at the block's start: the routing hands it to Lexical, which joins the paragraphs and so
      // deletes the struck "a" with the rest of the block.
      mounted.act(() => {
        const node = texts().find((text) => text.getTextContent().startsWith('abc'))!;
        caretIn(node, 0).deleteCharacter(true);
      });
      link.deliver(mounted.fork);
    } finally {
      mounted.dispose();
    }
    expect(link.replies.filter((reply) => reply.t === 'suggest-refused')).toEqual([]);
    expect(recordIds(live)).toHaveLength(1);
    const [id] = recordIds(live);
    const record = readRecord(live, id)!;
    expect(record.parts, 'the strike').toHaveLength(1);
    expect(record.ops.length, 'the join').toBeGreaterThan(0);
    const preview = previewRecord(live, id);
    expect(preview, 'an honest record is not outdated').toMatchObject({ ok: true });
    if (!preview.ok) return;
    expect(acceptRecord(live, id, { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toMatchObject({ ok: true });
    expect(exported(live)).not.toContain('\n\nabc tail.');
  });
});

// ---- The generative honest-edit fuzz -------------------------------------------------------------------------------

interface HonestStep {
  label: string;
  step: Step;
}

const WORDS = ['the ', 'cat ', 'x', 'world ', 'Hello ', ' and', 'é', '  '];
const BLOCKS = [
  'New {{3*3|9}} here.',
  'See [a link](https://example.invalid) and {{2+2|4}} after it.',
  '```js\nfresh\n```',
  '```moss-html\n<i>fresh</i>\n```',
  '- [ ] new task',
  '> fresh quote',
];

const texts = (): TextNode[] => all().filter((node): node is TextNode => $isTextNode(node) && node.isAttached());

function caretIn(node: TextNode, anchor: number, focus = anchor) {
  const selection = $createRangeSelection();
  selection.anchor.set(node.getKey(), anchor, 'text');
  selection.focus.set(node.getKey(), focus, 'text');
  $setSelection(selection);
  return selection;
}

/** A text position chosen by two fractions, the same on F and in the oracle, since both hold the same tree. */
function textAt(r1: number, r2: number): { node: TextNode; offset: number } | null {
  const list = texts();
  if (!list.length) return null;
  const node = list[Math.floor(r1 * list.length)];
  return { node, offset: Math.floor(r2 * (node.getTextContentSize() + 1)) };
}

function honestSteps(random: () => number, count: number): HonestStep[] {
  const steps: HonestStep[] = [];
  for (let i = 0; i < count; i += 1) {
    const [r1, r2, r3, r4] = [random(), random(), random(), random()];
    switch (int(random, 12)) {
      case 0:
      case 1: {
        const word = pick(random, WORDS);
        const colliding = random() < 0.4;
        steps.push({
          label: colliding ? 'type a colliding prefix' : `type ${JSON.stringify(word)}`,
          step: () => {
            const at = textAt(r1, r2);
            if (!at) return;
            const text = colliding ? `${at.node.getTextContent().slice(at.offset, at.offset + 4) || 'a'} ` : word;
            caretIn(at.node, at.offset).insertText(text);
          },
        });
        break;
      }
      case 2:
        steps.push({ label: 'Enter', step: () => { const at = textAt(r1, r2); if (at) caretIn(at.node, at.offset).insertParagraph(); } });
        break;
      case 3:
        steps.push({ label: 'Shift+Enter', step: () => { const at = textAt(r1, r2); if (at) caretIn(at.node, at.offset).insertLineBreak(); } });
        break;
      case 4: {
        const format = pick(random, ['bold', 'italic', 'strikethrough', 'code'] as const);
        steps.push({
          label: `format ${format}`,
          step: () => {
            const at = textAt(r1, r2);
            if (!at || at.node.getTextContentSize() < 2) return;
            const size = at.node.getTextContentSize();
            const from = Math.min(at.offset, size - 1);
            caretIn(at.node, from, from + 1 + Math.floor(r3 * (size - from - 1))).formatText(format);
          },
        });
        break;
      }
      case 5:
        steps.push({ label: 'undo', step: 'undo' });
        break;
      case 6:
        steps.push({
          label: 'Tab in a list',
          step: () => {
            const items = all().filter($isListItemNode);
            if (!items.length) return;
            const item = items[Math.floor(r1 * items.length)];
            if (item.getIndent() < 3) item.setIndent(item.getIndent() + 1);
          },
        });
        break;
      case 7:
        steps.push({
          label: 'table row insert',
          step: () => {
            const cells = all().filter($isTableCellNode);
            if (cells.length) $insertTableRowAtNode(cells[Math.floor(r1 * cells.length)], r2 < 0.5);
          },
        });
        break;
      case 8:
        steps.push({
          label: 'checkbox',
          step: () => {
            const items = all().filter($isListItemNode).filter((item) => item.getChecked() !== undefined);
            if (items.length) {
              const item = items[Math.floor(r1 * items.length)];
              item.setChecked(!item.getChecked());
            }
          },
        });
        break;
      case 9: {
        const markdown = pick(random, BLOCKS);
        steps.push({
          label: `new block ${JSON.stringify(markdown.slice(0, 16))}`,
          step: () => {
            const children = $getRoot().getChildren();
            const json = (importMarkdown(markdown).getEditorState().toJSON().root.children as SerializedLexicalNode[])[0];
            children[Math.floor(r1 * children.length)].insertAfter($parseSerializedNode(json));
          },
        });
        break;
      }
      case 10:
        steps.push({
          label: r3 < 0.5 ? 'Backspace' : 'Delete',
          step: () => {
            // A one-character range removed as Backspace or Delete removes it; at a block's start, Backspace joins.
            // Lexical's own character extension reads the DOM selection, which a headless editor lacks.
            const at = textAt(r1, r2);
            if (!at) return;
            const size = at.node.getTextContentSize();
            if (r3 < 0.5 && at.offset > 0) caretIn(at.node, at.offset - 1, at.offset).removeText();
            else if (r3 >= 0.5 && at.offset < size) caretIn(at.node, at.offset, at.offset + 1).removeText();
            else if (r3 < 0.5 && at.node.getPreviousSibling() === null && at.node.getParent()?.getParent()?.getType() === 'root') caretIn(at.node, 0).deleteCharacter(true);
          },
        });
        break;
      default: {
        const word = pick(random, WORDS);
        steps.push({
          label: 'edit a code block',
          step: () => {
            const blocks = all().filter((node) => node.getType() === 'code-block') as unknown as { getCode(): string; setCode(code: string): void }[];
            if (blocks.length) {
              const block = blocks[Math.floor(r4 * blocks.length)];
              block.setCode(block.getCode() + word);
            }
          },
        });
      }
    }
  }
  return steps;
}

/**
 * One honest session: a suggester's fork with a real moss editor makes `steps`, every frame through the real ingest.
 * Zero refusals, zero broken records, and accepting every record equals an editor making the same steps directly.
 */
function honestSession(seed: number): string[] {
  try {
    return honestRun(seed);
  } catch (error) {
    return [`seed ${seed}: threw ${(error as Error).stack?.split('\n').slice(0, 6).join(' | ') ?? String(error)}`];
  }
}

function honestRun(seed: number): string[] {
  const random = rng(seed);
  const steps = honestSteps(random, 3 + int(random, 5));
  const live = seededBody();
  let n = 0;
  const link = wire(live, () => `r${(n += 1)}`);
  const problems: string[] = [];
  resetIds();
  const mounted = mount(live, link);
  try {
    for (const { step } of steps) mounted.act(step);
    link.deliver(mounted.fork);
  } finally {
    mounted.dispose();
  }
  const refused = link.replies.filter((reply) => reply.t === 'suggest-refused');
  if (refused.length) problems.push(`ingest refused ${refused.map((reply) => (reply as { reason: string }).reason).join(', ')}`);
  const built = new Composite(live).build();
  if (built.broken.length) problems.push(`broken records ${built.broken.join(', ')}`);
  built.doc.destroy();
  const open = recordIds(live)
    .map((id) => readMeta(live, id)!)
    .filter((meta) => meta.status === 'open')
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const meta of open) {
    const preview = previewRecord(live, meta.id);
    if (!preview.ok) {
      problems.push(`preview of ${meta.id} refused ${preview.reason}`);
      continue;
    }
    const result = acceptRecord(live, meta.id, { previewHash: preview.hash, digest: preview.digest }, EDITOR);
    if (!result.ok) problems.push(`accept of ${meta.id} refused ${result.reason}`);
  }
  resetIds();
  const oracle = directEdit(seededBody(), steps.map(({ step }) => step));
  if (exported(live) !== exported(oracle)) problems.push(`accept differs from the direct edit:\n--- accepted\n${exported(live)}\n--- direct\n${exported(oracle)}`);
  else if (canonical(payloadsInOrder(live)) !== canonical(payloadsInOrder(oracle))) problems.push('accepted payloads differ from the direct edit');
  return problems.map((problem) => `seed ${seed} [${steps.map((s) => s.label).join(', ')}]: ${problem}`);
}

describe('T5.4 generative honest-edit fuzz through real moss editors in suggest mode @p:mean-2 @p:R17', () => {
  it.each([0, 1, 2, 3])('zero refusals, zero broken records, and accept equals the direct edit (batch %i)', (batch) => {
    const failures = seedsFrom(9_000 + batch * 8, 8).flatMap((seed) => honestSession(seed));
    expect(failures).toEqual([]);
  }, 120_000);
});
