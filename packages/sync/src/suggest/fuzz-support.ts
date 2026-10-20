// T5.4's adversarial fuzz (docs/design/suggestions.md §9): a seeded generator, a V1 struct codec, and mutators that
// turn a real fork's frames into forged ones at the struct level. Test-only.
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import type { DeletePart, IdSpan, RecordOp } from '@moss-multi/core/suggest/apply';

/** mulberry32: a small seeded generator, so a failing case replays from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length)];
export const int = (random: () => number, max: number): number => Math.floor(random() * max);

type Struct = Y.Item | Y.GC | Y.Skip;

/** A decoded V1 update whose structs and delete set the mutators edit in place. */
export interface Frame {
  structs: Struct[];
  ds: Map<number, { clock: number; len: number }[]>;
}

export function decodeFrame(update: Uint8Array): Frame {
  const { structs, ds } = Y.decodeUpdate(update);
  const copy = new Map<number, { clock: number; len: number }[]>();
  for (const [client, ranges] of (ds as unknown as { clients: Map<number, { clock: number; len: number }[]> }).clients) {
    copy.set(client, ranges.map(({ clock, len }) => ({ clock, len })));
  }
  return { structs: [...structs], ds: copy };
}

/**
 * The frame as V1 bytes. Each client's structs are written from its lowest clock in clock order; a hole between two
 * becomes a Skip, so a gap survives encoding as the forger meant it.
 */
export function encodeFrame({ structs, ds }: Frame): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  const rest = encoder.restEncoder;
  const byClient = new Map<number, Struct[]>();
  for (const struct of structs) byClient.set(struct.id.client, [...(byClient.get(struct.id.client) ?? []), struct]);
  encoding.writeVarUint(rest, byClient.size);
  for (const [client, list] of [...byClient].sort(([a], [b]) => b - a)) {
    list.sort((a, b) => a.id.clock - b.id.clock);
    const out: Struct[] = [];
    let at = list[0].id.clock;
    for (const struct of list) {
      if (struct.id.clock > at) out.push(new Y.Skip(Y.createID(client, at), struct.id.clock - at));
      out.push(struct);
      at = Math.max(at, struct.id.clock + struct.length);
    }
    encoding.writeVarUint(rest, out.length);
    encoder.writeClient(client);
    encoding.writeVarUint(rest, list[0].id.clock);
    for (const struct of out) struct.write(encoder as never, 0);
  }
  encoding.writeVarUint(rest, ds.size);
  for (const [client, ranges] of ds) {
    encoding.writeVarUint(rest, client);
    encoding.writeVarUint(rest, ranges.length);
    for (const { clock, len } of ranges) {
      encoding.writeVarUint(rest, clock);
      encoding.writeVarUint(rest, len);
    }
  }
  return encoder.toUint8Array();
}

/** A copy of `item` with some fields replaced; a parent is required when it has neither origin. */
export function remake(item: Y.Item, patch: Partial<{ id: Y.ID; origin: Y.ID | null; rightOrigin: Y.ID | null; parent: string | Y.ID | null; parentSub: string | null; content: Y.Item['content'] }>): Y.Item {
  const next = { id: item.id, origin: item.origin, rightOrigin: item.rightOrigin, parent: item.parent as unknown, parentSub: item.parentSub, content: item.content, ...patch };
  if (next.origin === null && next.rightOrigin === null && !(typeof next.parent === 'string' || next.parent instanceof Y.ID)) next.parent = 'root';
  return new Y.Item(next.id, null, next.origin, null, next.rightOrigin, next.parent as never, next.parentSub, next.content);
}

/** What a forger can aim at: ids in the live note and its payloads, in other roots, and payload ids to alias. */
export interface Targets {
  /** Items of the body: blocks, characters, properties and decorators. */
  body: Y.ID[];
  /** Items under other roots: the title, frontmatter, comments, the suggestions map. */
  other: Y.ID[];
  /** Items holding a decorator (an XmlElement), whose `__regId` can be re-pointed. */
  decorators: Y.ID[];
  /** Payload ids the note knows, plus ids it does not. */
  payloadIds: string[];
  /** Items of payload docs, by payload id. */
  payload: Map<string, Y.ID[]>;
  /** Clients that are not the record's. */
  foreign: number[];
}

export function targetsOf(live: Y.Doc, payloads: ReadonlyMap<string, Y.Doc>, foreign: number[]): Targets {
  const body: Y.ID[] = [];
  const other: Y.ID[] = [];
  const decorators: Y.ID[] = [];
  const root = live.get('root', Y.XmlText);
  for (const [, structs] of live.store.clients) {
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      let top = struct.parent as Y.AbstractType<unknown> | null;
      while (top?._item) top = top._item.parent as Y.AbstractType<unknown>;
      (top === root ? body : other).push(struct.id);
      if (struct.content instanceof Y.ContentType && struct.content.type instanceof Y.XmlElement) decorators.push(struct.id);
    }
  }
  const payload = new Map<string, Y.ID[]>();
  for (const [id, doc] of payloads) {
    const ids: Y.ID[] = [];
    for (const [, structs] of doc.store.clients) for (const struct of structs) ids.push(struct.id);
    payload.set(id, ids);
  }
  return { body, other, decorators, payloadIds: [...payloads.keys(), 'fresh-a', 'fresh-b', '../escape', ''], payload, foreign };
}

const ROOT_NAMES = ['root', 'title', 'frontmatter', 'comments', 'suggestions', 'registers', 'payload', 'payload-map', 'elsewhere'];

function randomContent(random: () => number): Y.Item['content'] {
  switch (int(random, 11)) {
    case 0: return new Y.ContentString(pick(random, ['x', 'forged', 'the ', '\n']));
    case 1: return new Y.ContentAny([pick(random, [1, 'x', null, true, { __type: 'paragraph' }])]);
    case 2: return new Y.ContentFormat(pick(random, ['bold', '__type', 'href']), pick(random, [true, null, 'x']) as never);
    case 3: return new Y.ContentEmbed({ forged: 1 });
    case 4: return new Y.ContentBinary(new Uint8Array([1, 2, 3]));
    case 5: return new Y.ContentJSON([1, 'x']);
    case 6: return new Y.ContentDeleted(1 + int(random, 3));
    case 7: return new Y.ContentType(new Y.XmlText());
    case 8: return new Y.ContentType(new Y.XmlElement(pick(random, ['UNDEFINED', 'p', 'formula'])));
    case 9: return new Y.ContentType(pick(random, [new Y.Map(), new Y.Array(), new Y.Text()]));
    default: return new Y.ContentDoc(new Y.Doc({ guid: 'forged-subdoc' }));
  }
}

/** The next clock `client` would write after `ops`. */
function nextClock(frame: Frame, client: number): number {
  let next = 0;
  for (const struct of frame.structs) if (struct.id.client === client) next = Math.max(next, struct.id.clock + struct.length);
  return next;
}

export interface Mutation {
  name: string;
  apply(frame: Frame, random: () => number, context: { lease: number; targets: Targets; doc: string }): boolean;
}

const items = (frame: Frame) => frame.structs.filter((s): s is Y.Item => s instanceof Y.Item);

/** An id a forged origin or parent may name: the note's, another root's, the frame's own, or one nobody wrote. */
function anyId(random: () => number, frame: Frame, context: { lease: number; targets: Targets; doc: string }): Y.ID {
  const own = items(frame).map((item) => Y.createID(item.id.client, item.id.clock + int(random, item.length)));
  const pools = [context.targets.body, context.targets.other, own, context.targets.payload.get(context.doc) ?? [], [Y.createID(context.lease, 1_000_000), Y.createID(pick(random, context.targets.foreign), 0)]];
  const pool = pick(random, pools.filter((p) => p.length > 0));
  return pick(random, pool);
}

export const MUTATIONS: Mutation[] = [
  {
    name: 'retarget an origin',
    apply(frame, random, context) {
      const list = items(frame);
      if (!list.length) return false;
      const at = frame.structs.indexOf(pick(random, list));
      const item = frame.structs[at] as Y.Item;
      const id = anyId(random, frame, context);
      const how = int(random, 3);
      frame.structs[at] = how === 0 ? remake(item, { origin: id }) : how === 1 ? remake(item, { rightOrigin: id }) : remake(item, { origin: null, rightOrigin: null, parent: random() < 0.5 ? id : pick(random, ROOT_NAMES) });
      return true;
    },
  },
  {
    name: 'swap a content kind',
    apply(frame, random) {
      const list = items(frame);
      if (!list.length) return false;
      const at = frame.structs.indexOf(pick(random, list));
      frame.structs[at] = remake(frame.structs[at] as Y.Item, { content: randomContent(random) });
      return true;
    },
  },
  {
    name: 'add deletes',
    apply(frame, random, context) {
      const pool = [...context.targets.body, ...context.targets.other, ...(context.targets.payload.get(context.doc) ?? []), ...items(frame).map((item) => item.id)];
      if (!pool.length) return false;
      for (let n = 1 + int(random, 4); n > 0; n -= 1) {
        const id = pick(random, pool);
        const ranges = frame.ds.get(id.client) ?? [];
        ranges.push({ clock: id.clock, len: 1 + int(random, random() < 0.1 ? 10_000 : 4) });
        frame.ds.set(id.client, ranges);
      }
      return true;
    },
  },
  {
    name: 're-point a __regId',
    apply(frame, random, context) {
      const key = pick(random, context.targets.payloadIds);
      const named = items(frame).filter((item) => item.parentSub === '__regId');
      if (named.length && random() < 0.6) {
        const at = frame.structs.indexOf(pick(random, named));
        frame.structs[at] = remake(frame.structs[at] as Y.Item, { content: new Y.ContentAny([key]) });
        return true;
      }
      const holders = [...context.targets.decorators, ...items(frame).filter((item) => item.content instanceof Y.ContentType).map((item) => item.id)];
      if (!holders.length) return false;
      const id = Y.createID(context.lease, nextClock(frame, context.lease));
      frame.structs.push(new Y.Item(id, null, null, null, null, pick(random, holders) as never, '__regId', new Y.ContentAny([key])));
      return true;
    },
  },
  {
    name: 'write a non-body root',
    apply(frame, random, context) {
      const id = Y.createID(context.lease, nextClock(frame, context.lease));
      const sub = random() < 0.5 ? null : pick(random, ['k', '__type', 'meta']);
      frame.structs.push(new Y.Item(id, null, null, null, null, pick(random, ROOT_NAMES.filter((name) => name !== 'root')) as never, sub, randomContent(random)));
      return true;
    },
  },
  {
    name: 'use a client the record does not lease',
    apply(frame, random, context) {
      const list = items(frame);
      if (!list.length) return false;
      const foreign = pick(random, context.targets.foreign);
      const all = random() < 0.5;
      const chosen = all ? list : [pick(random, list)];
      const base = nextClock(frame, foreign);
      for (const item of chosen) {
        const at = frame.structs.indexOf(item);
        frame.structs[at] = remake(item, { id: Y.createID(foreign, all ? item.id.clock : base) });
      }
      return true;
    },
  },
  {
    name: 'open a gap',
    apply(frame, random) {
      const list = frame.structs;
      if (!list.length) return false;
      const from = int(random, list.length);
      const shift = 1 + int(random, 5);
      for (let i = from; i < list.length; i += 1) {
        const struct = list[i];
        const id = Y.createID(struct.id.client, struct.id.clock + shift);
        list[i] = struct instanceof Y.Item ? remake(struct, { id }) : struct instanceof Y.GC ? new Y.GC(id, struct.length) : new Y.Skip(id, struct.length);
      }
      return true;
    },
  },
  {
    name: 'GC a parent',
    apply(frame, random) {
      const parents = items(frame).filter((item) => item.content instanceof Y.ContentType);
      const list = parents.length ? parents : items(frame);
      if (!list.length) return false;
      const item = pick(random, list);
      frame.structs[frame.structs.indexOf(item)] = new Y.GC(item.id, item.length);
      if (random() < 0.5) frame.ds.set(item.id.client, [...(frame.ds.get(item.id.client) ?? []), { clock: item.id.clock, len: item.length }]);
      return true;
    },
  },
];

/** Record-level forgeries: the op's doc, the op list, the leased clients and the delete parts. */
export function mutateRecord(
  random: () => number,
  ops: RecordOp[],
  clients: number[],
  parts: DeletePart[],
  targets: Targets,
): string {
  switch (int(random, 6)) {
    case 0: {
      if (!ops.length) return 'no op to re-aim';
      const op = pick(random, ops);
      op.doc = pick(random, ['body', ...targets.payloadIds]);
      return `re-aim an op at ${JSON.stringify(op.doc)}`;
    }
    case 1: {
      if (!ops.length) return 'no op to duplicate';
      ops.push({ ...pick(random, ops) });
      return 'duplicate an op';
    }
    case 2: {
      ops.reverse();
      return 'reverse the ops';
    }
    case 3: {
      if (random() < 0.5) clients.push(pick(random, targets.foreign));
      else clients.splice(0, clients.length);
      return `forge the leased clients: ${clients.length}`;
    }
    case 4: {
      const pool = [...targets.body, ...targets.other];
      const spans: IdSpan[] = [];
      for (let n = 1 + int(random, 3); n > 0; n -= 1) {
        const id = pick(random, pool);
        spans.push({ client: id.client, clock: id.clock, len: 1 + int(random, 6) });
      }
      parts.push({ id: `p${parts.length}`, kind: 'delete', targets: spans, quote: '' });
      return 'add a delete part';
    }
    default: {
      if (!ops.length) return 'no op to truncate';
      const op = pick(random, ops);
      op.update = op.update.slice(0, Math.max(1, int(random, op.update.length)));
      return 'truncate an op';
    }
  }
}

/** One struct-level mutation of a random op, re-encoded; returns its name. */
export function mutateOp(random: () => number, ops: RecordOp[], lease: number, targets: Targets): string {
  if (!ops.length) return 'no op';
  const op = pick(random, ops);
  let frame: Frame;
  try {
    frame = decodeFrame(op.update);
  } catch {
    return 'undecodable op';
  }
  const mutation = pick(random, MUTATIONS);
  if (!mutation.apply(frame, random, { lease, targets, doc: op.doc })) return `${mutation.name} (no target)`;
  try {
    op.update = encodeFrame(frame);
  } catch (error) {
    return `${mutation.name} (unencodable: ${(error as Error).message})`;
  }
  return mutation.name;
}
