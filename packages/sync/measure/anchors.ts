// T4.2 workerd budget for comment anchors (docs/design/comments.md §5.6, I7). The DocDO's comments module
// (DocComments: gate 2b, the frame engine, writeComments) runs on a large note with 2,000 comments, hundreds of them
// long and orphaned, and takes client frames exactly as DocDO.onMessage and #afterFrame apply them. Setup builds the
// docs and encodes every frame; a timed request only applies frames, so scripts/measure-converter.mjs can divide its
// workerd CPU by its frame count. Docs are made in handlers: a Y.Doc draws a random id, which workerd refuses at
// global scope.
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { liveUnits, mintAnchor, type Anchor } from '@moss-multi/core/anchor-frame';
import { CommentsHost } from '../src/doc/comments-host.ts';
import { COMMENTS_CLIENT_META, DocComments } from '../src/doc/comments.ts';
import type { DocStore } from '../src/doc/persistence.ts';

const PARAGRAPHS = 400;
const WORDS = 10;
/** A paragraph's text: ten 6-character words, spaces, and a period. */
const TEXT = WORDS * 7;
/** Paragraphs whose text is deleted after their whole-paragraph comments are made: the long orphans. */
const ORPHANED = 240;
/** Comments that share the space after the first word of the last paragraph, with its whole-paragraph comment: 32. */
const SHARED = 31;
const RECORDS = 2_000;
export const KEY_FRAMES = 300;
export const SHARED_FRAMES = 50;
export const FORGED_FRAMES = 100;
export const LIFT_DOCS = 5;
/** Word comments in the paragraph a lift frame deletes. */
export const LIFT_COMMENTS = 500;
const CLIENT = 'measure-client';

const word = (n: number) => `w${String(n).padStart(5, '0')}`;

function addParagraph(root: Y.XmlText, index: number, text: string): void {
  const block = new Y.XmlText();
  root.insertEmbed(index, block);
  block.setAttribute('__type', 'paragraph');
  const node = new Y.Map();
  block.insertEmbed(0, node);
  node.set('__type', 'text');
  block.insert(1, text);
}

const blocks = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: Y.XmlText }[]).map((op) => op.insert);

function minted(doc: Y.Doc, from: number, length: number): Anchor {
  const { units } = liveUnits(doc);
  return mintAnchor(units[from], units[from + length - 1]);
}

/** A built note: its state and the reserved writer its records carry. */
interface Built {
  state: Uint8Array;
  r: number;
}

/** The large note: 400 paragraphs and 2,000 comments; the first 240 paragraphs' text is deleted, orphaning 240. */
function buildLarge(): Built {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  doc.transact(() => {
    for (let p = 0; p < PARAGRAPHS; p += 1) addParagraph(root, p, `${Array.from({ length: WORDS }, (_, w) => word(p * WORDS + w)).join(' ')}.`);
  });
  const host = new CommentsHost(doc);
  const text = liveUnits(doc).text;
  let made = 0;
  for (let p = 0; p < PARAGRAPHS; p += 1, made += 1) host.create(`p${p}`, minted(doc, p * TEXT, TEXT - 1));
  const shared = (PARAGRAPHS - 1) * TEXT + 6;
  for (let k = 0; k < SHARED; k += 1, made += 1) host.create(`s${k}`, minted(doc, shared, 2 + k));
  for (let n = ORPHANED * WORDS; made < RECORDS; n += 1, made += 1) host.create(`w${n}`, minted(doc, text.indexOf(word(n)), 6));
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  const paragraphs = blocks(client);
  for (let p = 0; p < ORPHANED; p += 1) {
    const sv = Y.encodeStateVector(doc);
    client.transact(() => paragraphs[p].delete(1, TEXT));
    host.receive(Y.encodeStateAsUpdate(client, sv));
  }
  return { state: Y.encodeStateAsUpdate(doc), r: host.writer.client };
}

/**
 * One paragraph of LIFT_COMMENTS commented words between two short ones. `orphaned`: its text is then deleted, so the
 * comments are orphans whose shared lost place is inside it, which a frame deleting the paragraph lifts.
 */
function buildLift(orphaned: boolean): Built {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  doc.transact(() => {
    addParagraph(root, 0, 'Head.');
    addParagraph(root, 1, `${Array.from({ length: LIFT_COMMENTS }, (_, n) => word(n)).join(' ')}.`);
    addParagraph(root, 2, 'Tail.');
  });
  const host = new CommentsHost(doc);
  const text = liveUnits(doc).text;
  for (let n = 0; n < LIFT_COMMENTS; n += 1) host.create(`w${n}`, minted(doc, text.indexOf(word(n)), 6));
  if (orphaned) {
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
    const sv = Y.encodeStateVector(doc);
    const paragraph = blocks(client)[1];
    client.transact(() => paragraph.delete(1, paragraph.length - 1));
    host.receive(Y.encodeStateAsUpdate(client, sv));
  }
  return { state: Y.encodeStateAsUpdate(doc), r: host.writer.client };
}

interface Target {
  doc: Y.Doc;
  comments: DocComments;
  frames: Uint8Array[];
}

/**
 * A DocDO's comments over a copy of `built`, rebuilt from its records as onStart does, and the frames a client replica
 * makes with `edits`, one per transaction.
 */
function target({ state, r }: Built, edits: (client: Y.Doc) => void): Target {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state, 'persistence');
  const meta = new Map([[COMMENTS_CLIENT_META, String(r)]]);
  const store = { meta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => meta.set(key, value) } as unknown as DocStore;
  const comments = new DocComments(doc, store);
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  const frames: Uint8Array[] = [];
  client.on('update', (update: Uint8Array) => frames.push(update));
  edits(client);
  return { doc, comments, frames };
}

/** One client frame, as DocDO.onMessage and #afterFrame apply it. */
function apply(t: Target, update: Uint8Array): void {
  if (t.comments.check(Y.decodeUpdate(update))) throw new Error('gate 2b refused the frame');
  Y.applyUpdate(t.doc, update, CLIENT);
  if (t.doc.store.pendingStructs || t.doc.store.pendingDs) throw new Error('the frame parked');
  t.comments.flush();
}

/** One forged item with any origin and right origin, encoded by hand as only a forger would write it. */
function forgedFrame(clock: number, origin: Y.ID, right: Y.ID): Uint8Array {
  const item = new Y.Item(Y.createID(4242, clock), null, origin, null, right, null, null, new Y.ContentString('q'));
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoder.writeClient(4242);
  encoding.writeVarUint(encoder.restEncoder, clock);
  item.write(encoder, 0);
  encoding.writeVarUint(encoder.restEncoder, 0);
  return encoder.toUint8Array();
}

const status = (t: Target, id: string) => t.doc.getMap<Anchor>('comments').get(`a:${id}`)?.status;

let targets: { keys: Target; shared: Target; forged: Target; lift: Target[]; lifted: Target[] } | null = null;

/** Builds every doc and encodes every frame; not held to a budget. */
export function setup(): { records: number; orphaned: number } {
  const large = buildLarge();
  const lift = buildLift(false);
  const lifted = buildLift(true);
  const keys = target(large, (client) => {
    const paragraphs = blocks(client);
    for (let i = 0; i < KEY_FRAMES / 2; i += 1) {
      // A character typed inside a word comment of a commented paragraph, then deleted: no endpoint is touched.
      const p = paragraphs[ORPHANED + 1 + (i % (PARAGRAPHS - ORPHANED - 2))];
      client.transact(() => p.insert(3, 'z'));
      client.transact(() => p.delete(3, 1));
    }
  });
  const shared = target(large, (client) => {
    const last = blocks(client)[PARAGRAPHS - 1];
    // The character 31 comments start on (and their paragraph's comment covers), deleted and typed again, as bolding
    // it rewrites it: every frame deletes an endpoint 31 comments share and re-mints them.
    for (let i = 0; i < SHARED_FRAMES; i += 1) {
      client.transact(() => {
        last.delete(7, 1);
        last.insert(7, ' ');
      });
    }
  });
  const forged = target(large, () => {});
  const comments = forged.doc.getMap<Anchor>('comments');
  for (let i = 0; i < FORGED_FRAMES; i += 1) {
    // Placed inside a long orphan's lost place: its left bound as origin, its deleted member as right origin.
    const lost = comments.get(`a:p${i % ORPHANED}`)?.lost;
    if (!lost?.segs[0].left) throw new Error(`p${i % ORPHANED} has no lost place`);
    const [lc, lk] = lost.segs[0].left;
    const [mc, mk] = lost.members[0];
    forged.frames.push(forgedFrame(i, Y.createID(lc, lk), Y.createID(mc, mk)));
  }
  targets = {
    keys,
    shared,
    forged,
    lift: Array.from({ length: LIFT_DOCS }, () => target(lift, (client) => client.get('root', Y.XmlText).delete(1, 1))),
    lifted: Array.from({ length: LIFT_DOCS }, () => target(lifted, (client) => client.get('root', Y.XmlText).delete(1, 1))),
  };
  const anchors = [...keys.doc.getMap<Anchor>('comments').entries()].filter(([key]) => key.startsWith('a:'));
  return { records: anchors.length, orphaned: anchors.filter(([, anchor]) => anchor.status === 'orphaned').length };
}

function ready() {
  if (!targets) throw new Error('setup first');
  return targets;
}

function applyAll(t: Target): number {
  for (const frame of t.frames) apply(t, frame);
  return t.frames.length;
}

/** The single-key frames. */
export function keys(): { frames: number } {
  return { frames: applyAll(ready().keys) };
}

/** The frames that delete and retype the character 31 comments start on; every one stays anchored. */
export function shared(): { frames: number; anchored: number } {
  const t = ready().shared;
  const frames = applyAll(t);
  let anchored = 0;
  for (let k = 0; k < SHARED; k += 1) if (status(t, `s${k}`) === 'anchored') anchored += 1;
  return { frames, anchored };
}

/** The forged one-item frames; every long orphan stays orphaned. */
export function forged(): { frames: number; orphaned: number } {
  const t = ready().forged;
  const frames = applyAll(t);
  let orphaned = 0;
  for (let p = 0; p < ORPHANED; p += 1) if (status(t, `p${p}`) === 'orphaned') orphaned += 1;
  return { frames, orphaned };
}

/** One frame per doc deleting the paragraph that holds LIFT_COMMENTS comments, which writes every orphan's record. */
export function lift(): { frames: number; orphaned: number } {
  let frames = 0;
  let orphaned = 0;
  for (const t of ready().lift) {
    frames += applyAll(t);
    for (let n = 0; n < LIFT_COMMENTS; n += 1) if (status(t, `w${n}`) === 'orphaned') orphaned += 1;
  }
  return { frames, orphaned };
}

/** One frame per doc deleting the paragraph that holds LIFT_COMMENTS orphans' lost place: each is lifted out of it. */
export function lifted(): { frames: number; lifted: number } {
  let frames = 0;
  let count = 0;
  for (const t of ready().lifted) {
    frames += applyAll(t);
    const comments = t.doc.getMap<Anchor>('comments');
    for (let n = 0; n < LIFT_COMMENTS; n += 1) {
      const anchor = comments.get(`a:w${n}`);
      if (anchor?.status === 'orphaned' && anchor.lost?.inner) count += 1;
    }
  }
  return { frames, lifted: count };
}
