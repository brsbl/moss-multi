// T6.1: the identity-preserving reconcile (A§14, SP12). Properties over generated bodies: the result exports the
// target; untouched blocks keep their Yjs items; a peer's concurrent insert into an untouched block survives; comment
// anchors on untouched text survive. Plus the edited-block, payload and verify-or-refuse cases.
import fc from 'fast-check';
import { $getRoot, $isElementNode, $isTextNode, type ElementNode, type LexicalNode, type SerializedEditorState, type TextNode } from 'lexical';
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

/** The payload id of the block at `index`. */
function regIdAt(doc: Y.Doc, index: number): string {
  const mirror = mirrorOf(doc);
  try {
    return mirror.editor.getEditorState().read(() => ($getRoot().getChildAtIndex(index) as unknown as { __regId: string }).__regId);
  } finally {
    mirror.dispose();
  }
}

/** The first payload node's id, in tree order. */
function payloadIdOf(doc: Y.Doc): string {
  const mirror = mirrorOf(doc);
  try {
    return mirror.editor.getEditorState().read(() => {
      const find = (node: LexicalNode): string | undefined => {
        const id = (node as unknown as { __regId?: string }).__regId;
        if (id) return id;
        if ($isElementNode(node)) for (const child of node.getChildren()) {
          const found = find(child);
          if (found) return found;
        }
        return undefined;
      };
      return find($getRoot())!;
    });
  } finally {
    mirror.dispose();
  }
}

/** The Yjs id of the visible character at `index` of `text`. */
function itemIdAt(text: Y.Text, index: number): { client: number; clock: number } | undefined {
  let left = index;
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue;
    if (left < item.length) return { client: item.id.client, clock: item.id.clock + left };
    left -= item.length;
  }
  return undefined;
}

/** Anchors a comment on the first occurrence of `quote`. */
function anchorOn(live: Y.Doc, quote: string): Anchor {
  const { text, units } = liveUnits(live);
  const at = text.indexOf(quote);
  expect(at, `"${quote}" is in the body`).toBeGreaterThanOrEqual(0);
  return mintAnchor(units[at]!, units[at + quote.length - 1]!);
}

/** Anchors a comment on the first occurrence of `quote` after `token`. */
function anchorAfter(live: Y.Doc, token: string, quote: string): Anchor {
  const { text, units } = liveUnits(live);
  const at = text.indexOf(quote, text.indexOf(token));
  expect(at, `"${quote}" follows ${token}`).toBeGreaterThan(text.indexOf(token));
  return mintAnchor(units[at]!, units[at + quote.length - 1]!);
}

// Generated bodies: every block carries a unique token, so an untouched block is recognisable on both sides.
type Kind = 'p' | 'h' | 'ul' | 'code' | 'q';
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'echo'];
/** Inserted blocks use other words, so an edited block is plainly more like its old self than like an insert. */
const NEW_WORDS = ['golf', 'hotel', 'kilo'];

/** An edit changes a block at both ends (`mid` after its token, `extra` at its end) and keeps its words between. */
function render(kind: Kind, token: string, words: string[], extra: string, mid = ''): string {
  const lead = mid ? [mid, ...words] : words;
  const body = [token, ...lead].join(' ') + extra;
  switch (kind) {
    case 'p': return body;
    case 'h': return `## ${body}`;
    case 'ul': return `- ${token}a ${lead.join(' ')}\n- ${token}b${extra}`;
    case 'code': return `\`\`\`js\n${body}\n\`\`\``;
    case 'q': return `> ${body}`;
  }
}

const block = fc.record({
  kind: fc.constantFrom<Kind>('p', 'p', 'h', 'ul', 'code', 'q'),
  words: fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 4 }),
});
const inserted = fc.record({
  kind: fc.constantFrom<Kind>('p', 'p', 'h', 'ul', 'code', 'q'),
  words: fc.array(fc.constantFrom(...NEW_WORDS), { minLength: 1, maxLength: 3 }),
});
const scenario = fc.record({
  base: fc.array(block, { minLength: 1, maxLength: 7 }),
  fates: fc.array(fc.constantFrom('keep', 'keep', 'edit', 'drop'), { minLength: 7, maxLength: 7 }),
  inserts: fc.array(fc.record({ at: fc.nat(8), block: inserted }), { maxLength: 3 }),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

const SENTINEL = 'sentinel zq closing words';

function build({ base, fates, inserts }: Scenario): { before: string; after: string } {
  const before = base.map((b, i) => render(b.kind, `k${i}x`, b.words, ''));
  const after: string[] = [];
  base.forEach((b, i) => {
    const fate = fates[i];
    if (fate === 'keep') after.push(before[i]!);
    else if (fate === 'edit') after.push(render(b.kind, `k${i}x`, b.words, ` zz${i}`, 'QQ'));
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

      // An edited text block keeps the words between its two edits, when its kind pairs it unambiguously: the only
      // live block of that kind, with no insert of that kind.
      s.base.forEach((b, i) => {
        if (s.fates[i] !== 'edit' || b.kind === 'code') return;
        if (s.base.filter((other) => other.kind === b.kind).length > 1) return;
        if (s.inserts.some(({ block: other }) => other.kind === b.kind)) return;
        const quote = b.words.join(' ');
        anchors.push({ quote, anchor: anchorAfter(live, `k${i}x`, quote) });
      });

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

  it('a text node changed at both ends keeps the items between: an anchor and a peer insert there survive', () => {
    const live = docOf('Intro.\n\nAlpha middle words stay Zulu');
    const targetDoc = docOf('Intro.\n\nBravo middle words stay Yankee');
    const anchor = anchorOn(live, 'middle words');
    const peer = fork(live);
    serverWrite(peer, 'peer', () => {
      $firstText($getRoot().getChildAtIndex(1))!.setTextContent('Alpha middle PEERwords stay Zulu');
    });
    expect(reconcileBody(live, bodyState(targetDoc), RESTORE)).toBe(true);
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(targetDoc));
    expect(anchorText(live, anchor)).toBe('middle words');
    share(peer, live);
    share(live, peer);
    expect(exportDocMarkdown(live)).toBe('Intro.\n\nBravo middle PEERwords stay Yankee');
    expect(exportDocMarkdown(peer)).toBe(exportDocMarkdown(live));
  });

  it('a long text node changed at both ends keeps the items between, past the character table, by code point and by word', () => {
    // 302 code points a side is past the server's 256 × 256 table; 90,000 characters is past a code-point search too.
    const cases = [
      { before: `A${'x'.repeat(300)}Z`, after: `B${'x'.repeat(300)}Y`, quote: 'x'.repeat(40), cut: 150 },
      {
        before: `Alpha ${Array.from({ length: 8000 }, (_, i) => `w${i}`).join(' ')} Zulu`,
        after: `Bravo ${Array.from({ length: 8000 }, (_, i) => `w${i}`).join(' ')} Yankee`,
        quote: 'w4000 w4001',
        cut: 30_000,
      },
    ];
    for (const { before, after, quote, cut } of cases) {
      const live = docOf(`Intro.\n\n${before}`);
      const targetDoc = docOf(`Intro.\n\n${after}`);
      const anchor = anchorOn(live, quote);
      const peer = fork(live);
      serverWrite(peer, 'peer', () => {
        $firstText($getRoot().getChildAtIndex(1))!.setTextContent(`${before.slice(0, cut)}PEER${before.slice(cut)}`);
      });
      expect(reconcileBody(live, bodyState(targetDoc), RESTORE)).toBe(true);
      expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(targetDoc));
      expect(anchorText(live, anchor)).toBe(quote);
      share(peer, live);
      share(live, peer);
      expect(firstTextOf(live, 1)).toBe(`${after.slice(0, cut)}PEER${after.slice(cut)}`);
      expect(exportDocMarkdown(peer)).toBe(exportDocMarkdown(live));
    }
  });

  it('a code block whose language changed keeps its node and payload id, and a peer edit to its payload survives', () => {
    const live = docOf('Para one.\n\n```js\nconst a = 1;\n```');
    const targetDoc = docOf('Para one.\n\n```python\nconst a = 2;\n```');
    const id = regIdAt(live, 1);
    const codeItem = blockItems(live)[1]!;
    const peer = fork(live);
    payloadText(payloadDocsFor(peer).hold(id)).insert(0, '// hi\n');

    reconcileBody(live, bodyState(targetDoc), RESTORE);
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(targetDoc));
    expect(regIdAt(live, 1)).toBe(id);
    expect(codeItem.deleted).toBe(false);
    share(peer, live);
    share(live, peer);
    expect(payloadText(payloadDocsFor(live).hold(id)).toString()).toBe('// hi\nconst a = 2;');
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(docOf('Para one.\n\n```python\n// hi\nconst a = 2;\n```')));
    expect(exportDocMarkdown(peer)).toBe(exportDocMarkdown(live));
  });

  it('a formula whose text and result changed keeps its node and payload id, and a peer edit to its payload survives', () => {
    const live = docOf('Total {{2+3|5}} here.');
    const targetDoc = docOf('Total {{2+4|6}} here.');
    const formulaOf = (doc: Y.Doc) => {
      const mirror = mirrorOf(doc);
      try {
        return mirror.editor.getEditorState().read(() => {
          const node = ($getRoot().getFirstChild() as ElementNode).getChildren().find((child) => child.getType() === 'formula');
          const fields = node as unknown as { __regId: string; __result: string } | undefined;
          return { id: fields?.__regId, result: fields?.__result };
        });
      } finally {
        mirror.dispose();
      }
    };
    const before = formulaOf(live);
    expect(before.id).toBeTruthy();
    const peer = fork(live);
    payloadText(payloadDocsFor(peer).hold(before.id!)).insert(0, '1+');

    reconcileBody(live, bodyState(targetDoc), RESTORE);
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(targetDoc));
    const after = formulaOf(live);
    expect(after.id).toBe(before.id);
    expect(after.result).toBe('6');
    share(peer, live);
    share(live, peer);
    expect(payloadText(payloadDocsFor(live).hold(before.id!)).toString()).toBe('1+2+4');
    expect(exportDocMarkdown(peer)).toBe(exportDocMarkdown(live));
  });

  it('a code block pairs with the target block whose payload it most resembles, not the first of its kind', () => {
    const live = docOf('Para one.\n\n```js\nconst a = 1;\n```');
    const targetDoc = docOf('Para one.\n\n```js\nunrelated\n```\n\n```js\nconst a = 2;\n```');
    const id = regIdAt(live, 1);
    const peer = fork(live);
    payloadText(payloadDocsFor(peer).hold(id)).insert(0, '// hi\n');

    reconcileBody(live, bodyState(targetDoc), RESTORE);
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(targetDoc));
    expect(regIdAt(live, 2)).toBe(id);
    expect(regIdAt(live, 1)).not.toBe(id);
    share(peer, live);
    share(live, peer);
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(docOf('Para one.\n\n```js\nunrelated\n```\n\n```js\n// hi\nconst a = 2;\n```')));
    expect(exportDocMarkdown(peer)).toBe(exportDocMarkdown(live));
  });

  it('a refused write after the mutation leaves the note and its payloads unchanged', () => {
    const live = docOf('Para one.\n\n```js\nconst a = 1;\n```');
    const id = (() => {
      const mirror = mirrorOf(live);
      try {
        return mirror.editor.getEditorState().read(() => ($getRoot().getChildAtIndex(1) as unknown as { __regId: string }).__regId);
      } finally {
        mirror.dispose();
      }
    })();
    const vector = Y.encodeStateVector(live);
    const payloadVector = Y.encodeStateVector(payloadDocsFor(live).hold(id));
    let seen: [string, Uint8Array][] = [];
    const refuse = (diff: Uint8Array, payloads: [string, Uint8Array][]) => {
      seen = payloads;
      expect(diff.byteLength).toBeGreaterThan(0);
      throw new ReconcileRefused('mismatch', 'refused by admission');
    };
    expect(() => reconcileBody(live, bodyState(docOf('Para two.\n\n```js\nconst a = 2;\n```')), RESTORE, refuse)).toThrow(ReconcileRefused);
    expect(seen.map(([payloadId]) => payloadId)).toContain(id);
    expect(Y.encodeStateVector(live)).toEqual(vector);
    expect(Y.encodeStateVector(payloadDocsFor(live).hold(id))).toEqual(payloadVector);
    expect(payloadText(payloadDocsFor(live).hold(id)).toString()).toBe('const a = 1;');
    expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(docOf('Para one.\n\n```js\nconst a = 1;\n```')));

    // A verify that fails after the mirror changed refuses the same way.
    expect(() => serverWrite(live, RESTORE, () => {
      $firstText($getRoot().getFirstChild())!.setTextContent('Changed.');
    }, undefined, () => {
      throw new ReconcileRefused('mismatch', 'refused by verify');
    })).toThrow(ReconcileRefused);
    expect(Y.encodeStateVector(live)).toEqual(vector);
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

  it('a payload changed at both ends past the character table keeps its middle: a peer insert there lands in place (T6.S3)', () => {
    // 302 code points a side is past the server's 256 × 256 table, and a single line defeats the line tier.
    const mid = 'x'.repeat(300);
    const sum = '1+'.repeat(160);
    const cases = [
      { body: (p: string) => `Para one.\n\n\`\`\`js\n${p}\n\`\`\``, before: `A${mid}Z`, after: `B${mid}Y`, insert: 'PEER', cut: 150 },
      { body: (p: string) => `Para one.\n\n\`\`\`moss-html\n${p}\n\`\`\``, before: `<p>A${mid}Z</p>`, after: `<p>B${mid}Y</p>`, insert: 'PEER', cut: 150 },
      { body: (p: string) => `Total {{${p}|1}} here.`, before: `2+${sum}3`, after: `4+${sum}5`, insert: '9+', cut: 150 },
    ];
    for (const { body, before, after, insert, cut } of cases) {
      const live = docOf(body(before));
      const targetDoc = docOf(body(after));
      const id = payloadIdOf(live);
      const blocks = blockItems(live);
      const text = () => payloadText(payloadDocsFor(live).hold(id));
      expect(text().toString()).toBe(before);
      const middleIds = [cut - 100, cut, cut + 100].map((at) => itemIdAt(text(), at));
      const peer = fork(live);
      payloadText(payloadDocsFor(peer).hold(id)).insert(cut, insert);

      reconcileBody(live, bodyState(targetDoc), RESTORE);
      expect(exportDocMarkdown(live)).toBe(exportDocMarkdown(targetDoc));
      expect(payloadIdOf(live)).toBe(id);
      const kept = blockItems(live);
      expect(kept.length).toBe(blocks.length);
      kept.forEach((item, i) => expect(item === blocks[i], `block ${i} keeps its item`).toBe(true));
      expect(text().toString()).toBe(after);
      for (const [at, itemId] of [cut - 100, cut, cut + 100].map((at, i) => [at, middleIds[i]!] as const)) {
        expect(itemIdAt(text(), at), `the item at ${at} is kept`).toEqual(itemId);
      }
      share(peer, live);
      share(live, peer);
      expect(text().toString()).toBe(`${after.slice(0, cut)}${insert}${after.slice(cut)}`);
      expect(payloadText(payloadDocsFor(peer).hold(id)).toString()).toBe(text().toString());
      expect(exportDocMarkdown(peer)).toBe(exportDocMarkdown(live));
    }
  });
});
