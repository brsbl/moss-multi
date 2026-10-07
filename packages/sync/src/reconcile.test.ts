// T6.1: the identity-preserving reconcile (A§14, SP12). Properties over generated bodies: the result exports the
// target; untouched blocks keep their Yjs items; a peer's concurrent insert into an untouched block survives; comment
// anchors on untouched text survive. Plus the edited-block, payload and verify-or-refuse cases.
import fc from 'fast-check';
import { $getRoot, $isElementNode, $isTextNode, type LexicalNode, type SerializedEditorState, type TextNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { anchorText, liveUnits, mintAnchor, type Anchor } from '@moss-multi/core/anchor-frame';
import { stableStringify } from '@moss-multi/core/reconcile';
import { payloadDocsFor, payloadText } from './payload-docs.ts';
import { bodyState, reconcileBody, ReconcileRefused } from './reconcile.ts';
import { stateToMarkdown } from './converter/index.ts';
import { exportDocMarkdown, importBody, mirrorOf, serverWrite } from './server-doc.ts';

const RESTORE = 'test-restore';

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  importBody(doc, markdown);
  return doc;
}

/** Note and payload states from `from` into `to`, both ways being two calls. */
function share(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
  const target = payloadDocsFor(to);
  for (const [id, doc] of payloadDocsFor(from).docs) {
    const held = target.hold(id);
    Y.applyUpdate(held, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(held)), 'remote');
  }
}

function fork(live: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  share(live, peer);
  return peer;
}

/** The live root's block items, in tree order. */
function blockItems(doc: Y.Doc): Y.Item[] {
  const items: Y.Item[] = [];
  for (let item = doc.get('root', Y.XmlText)._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentType) items.push(item);
  }
  return items;
}

const children = (state: SerializedEditorState) => state.root.children as unknown as Record<string, unknown>[];

function $firstText(node: LexicalNode | null): TextNode | null {
  if (!node) return null;
  if ($isTextNode(node)) return node;
  if ($isElementNode(node)) for (const child of node.getChildren()) {
    const found = $firstText(child);
    if (found) return found;
  }
  return null;
}

/** The first text node's text of block `index`, or null when it has none. */
function firstTextOf(live: Y.Doc, index: number): string | null {
  const mirror = mirrorOf(live);
  try {
    return mirror.editor.getEditorState().read(() => $firstText($getRoot().getChildAtIndex(index))?.getTextContent() ?? null);
  } finally {
    mirror.dispose();
  }
}

/** Anchors a comment on the first occurrence of `quote`. */
function anchorOn(live: Y.Doc, quote: string): Anchor {
  const { text, units } = liveUnits(live);
  const at = text.indexOf(quote);
  expect(at, `"${quote}" is in the body`).toBeGreaterThanOrEqual(0);
  return mintAnchor(units[at]!, units[at + quote.length - 1]!);
}

// Generated bodies: every block carries a unique token, so an untouched block is recognisable on both sides.
type Kind = 'p' | 'h' | 'ul' | 'code' | 'q';
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'echo'];

function render(kind: Kind, token: string, words: string[], extra: string): string {
  const body = [token, ...words].join(' ') + extra;
  switch (kind) {
    case 'p': return body;
    case 'h': return `## ${body}`;
    case 'ul': return `- ${token}a ${words.join(' ')}\n- ${token}b${extra}`;
    case 'code': return `\`\`\`js\n${body}\n\`\`\``;
    case 'q': return `> ${body}`;
  }
}

const block = fc.record({
  kind: fc.constantFrom<Kind>('p', 'p', 'h', 'ul', 'code', 'q'),
  words: fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 4 }),
});
const scenario = fc.record({
  base: fc.array(block, { minLength: 1, maxLength: 7 }),
  fates: fc.array(fc.constantFrom('keep', 'keep', 'edit', 'drop'), { minLength: 7, maxLength: 7 }),
  inserts: fc.array(fc.record({ at: fc.nat(8), block }), { maxLength: 3 }),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

const SENTINEL = 'sentinel zq closing words';

function build({ base, fates, inserts }: Scenario): { before: string; after: string } {
  const before = base.map((b, i) => render(b.kind, `k${i}x`, b.words, ''));
  const after: string[] = [];
  base.forEach((b, i) => {
    const fate = fates[i];
    if (fate === 'keep') after.push(before[i]!);
    else if (fate === 'edit') after.push(render(b.kind, `k${i}x`, b.words, ` zz${i}`));
  });
  inserts.forEach(({ at, block: b }, j) => after.splice(Math.min(at, after.length), 0, render(b.kind, `n${j}x`, b.words, '')));
  return { before: [...before, SENTINEL].join('\n\n'), after: [...after, SENTINEL].join('\n\n') };
}

describe('T6.1 identity-preserving reconcile @p:mean-3 @p:tech-5', () => {
  it('lands the target, keeps untouched blocks, their anchors and a concurrent peer insert', () => {
    fc.assert(fc.property(scenario, fc.nat(), (s, pickSeed) => {
      const { before, after } = build(s);
      const live = docOf(before);
      const targetDoc = docOf(after);
      const target = bodyState(targetDoc);
      const expected = exportDocMarkdown(targetDoc);

      // Untouched: a live block whose whole subtree occurs once in the target.
      const liveState = bodyState(live);
      const targetSigs = children(target).map(stableStringify);
      const items = blockItems(live);
      expect(items.length).toBe(children(liveState).length);
      const untouched = children(liveState)
        .map((json, index) => ({ index, sig: stableStringify(json) }))
        .filter(({ sig }) => targetSigs.filter((other) => other === sig).length === 1)
        .map(({ index }) => index);
      expect(untouched.length).toBeGreaterThan(0);

      const anchors = untouched.map((index) => {
        const text = firstTextOf(live, index);
        return text ? { quote: text, anchor: anchorOn(live, text) } : null;
      }).filter((entry) => entry !== null);

      // A peer inserts into one untouched block's text while the reconcile runs.
      const withText = untouched.filter((index) => firstTextOf(live, index) !== null);
      const peerBlock = withText[pickSeed % withText.length]!;
      const peerText = firstTextOf(live, peerBlock)!;
      const peerEdited = `${peerText.slice(0, 3)}PEER${peerText.slice(3)}`;
      const peer = fork(live);
      serverWrite(peer, 'peer', () => {
        const node = $firstText($getRoot().getChildAtIndex(peerBlock));
        node!.setTextContent(peerEdited);
      });

      reconcileBody(live, target, RESTORE);
      expect(exportDocMarkdown(live)).toBe(expected);
      for (const index of untouched) expect(items[index]!.deleted, `block ${index} keeps its item`).toBe(false);
      for (const { quote, anchor } of anchors) expect(anchorText(live, anchor)).toBe(quote);

      share(peer, live);
      share(live, peer);
      const merged = expected.replace(peerText, peerEdited);
      expect(exportDocMarkdown(live)).toBe(merged);
      expect(exportDocMarkdown(peer)).toBe(merged);
    }), { numRuns: 40 });
  });

  it('an edited block keeps its own items: an anchor and a peer insert in its retained text survive', () => {
    const live = docOf('Intro line here.\n\nThe quick brown fox jumps.\n\nTail line.');
    const targetDoc = docOf('Intro line here.\n\nA brand new line.\n\nThe quick brown fox jumps over.\n\nTail line.');
    const anchor = anchorOn(live, 'quick brown');
    const peer = fork(live);
    serverWrite(peer, 'peer', () => {
      const node = $firstText($getRoot().getChildAtIndex(1))!;
      node.setTextContent('The very quick brown fox jumps.');
    });
    expect(reconcileBody(live, bodyState(targetDoc), RESTORE)).toBe(true);
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(targetDoc));
    expect(anchorText(live, anchor)).toBe('quick brown');
    share(peer, live);
    share(live, peer);
    expect(exportDocMarkdown(live)).toBe('Intro line here.\n\nA brand new line.\n\nThe very quick brown fox jumps over.\n\nTail line.');
    expect(exportDocMarkdown(peer)).toBe(exportDocMarkdown(live));
  });

  it('a changed code block keeps its node and payload id, and a peer edit to its payload survives', () => {
    const live = docOf('Para one.\n\n```js\nconst a = 1;\n```');
    const targetDoc = docOf('Para one.\n\n```js\nconst a = 2;\nconst b = 3;\n```');
    const regIdOf = (doc: Y.Doc) => {
      const mirror = mirrorOf(doc);
      try {
        return mirror.editor.getEditorState().read(() => ($getRoot().getChildAtIndex(1) as unknown as { __regId: string }).__regId);
      } finally {
        mirror.dispose();
      }
    };
    const id = regIdOf(live);
    const codeItem = blockItems(live)[1]!;
    const peer = fork(live);
    payloadText(payloadDocsFor(peer).hold(id)).insert(0, '// hi\n');

    reconcileBody(live, bodyState(targetDoc), RESTORE);
    expect(regIdOf(live)).toBe(id);
    expect(codeItem.deleted).toBe(false);
    expect(payloadText(payloadDocsFor(live).hold(id)).toString()).toBe('const a = 2;\nconst b = 3;');
    share(peer, live);
    share(live, peer);
    expect(payloadText(payloadDocsFor(live).hold(id)).toString()).toBe('// hi\nconst a = 2;\nconst b = 3;');
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(docOf('Para one.\n\n```js\n// hi\nconst a = 2;\nconst b = 3;\n```')));
  });

  it('a no-op target writes nothing', () => {
    const live = docOf('Same text.\n\n- one\n- two');
    const vector = Y.encodeStateVector(live);
    expect(reconcileBody(live, bodyState(docOf('Same text.\n\n- one\n- two')), RESTORE)).toBe(false);
    expect(Y.encodeStateVector(live)).toEqual(vector);
  });

  it('verify or refuse: a target it cannot land exactly is refused with 409 and writes nothing', () => {
    const good = bodyState(docOf('Other text.'));
    const paragraph = children(good)[0]!;
    const withChildren = (list: unknown[]) => ({ root: { ...good.root, children: list } }) as unknown as SerializedEditorState;
    const refusedWithNothingWritten = (target: SerializedEditorState): boolean => {
      const live = docOf('Keep me.');
      const vector = Y.encodeStateVector(live);
      try {
        reconcileBody(live, target, RESTORE);
      } catch (error) {
        expect(error).toBeInstanceOf(ReconcileRefused);
        expect((error as ReconcileRefused).status).toBe(409);
        expect(Y.encodeStateVector(live)).toEqual(vector);
        expect(exportDocMarkdown(live)).toBe('Keep me.');
        return true;
      }
      // Whatever lands exports exactly as the target does.
      expect(exportDocMarkdown(live)).toBe(stateToMarkdown(target));
      return false;
    };
    expect(refusedWithNothingWritten(withChildren([{ ...paragraph, type: 'no-such-node' }]))).toBe(true);
    refusedWithNothingWritten(withChildren([...(paragraph.children as unknown[])]));
    refusedWithNothingWritten(withChildren([{ ...paragraph, type: 'listitem', value: 1 }]));
  });
});
