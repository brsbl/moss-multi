// T7.2: the structural push merge (A§17). A pushed `.md` file is merged three ways against the pulled base and the
// live doc, then landed through the identity-preserving reconcile: untouched blocks keep their Yjs items, duplicate
// blocks keep their positions, a `:::tabs` block stays one block whose panels merge, a peer's concurrent typing in
// the same paragraph survives, and a degenerate push is refused unless forced. @p:agt-1 @p:tech-5 @p:tech-7
import { $getRoot, $isElementNode, $isTextNode, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { liveUnits } from '@moss-multi/core/anchor-frame';
import { readFrontmatter } from '@moss-multi/core/frontmatter';
import { landPush } from './push.ts';
import { bodyState } from './reconcile.ts';
import { exportDocMarkdown, importBody, serverWrite } from './server-doc.ts';

const PUSH = 'test-push';
const NOTE = 'note-1';

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  importBody(doc, markdown);
  return doc;
}

const exported = (doc: Y.Doc): string => exportDocMarkdown(doc, NOTE);

function fork(live: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(live), 'remote');
  return peer;
}

function share(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
}

/** The live root's block items, in order, as `client:clock` ids. */
function blockIds(doc: Y.Doc): string[] {
  const ids: string[] = [];
  for (let item = doc.get('root', Y.XmlText)._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentType) ids.push(`${item.id.client}:${item.id.clock}`);
  }
  return ids;
}

/** The Yjs id of each character of `quote`'s first occurrence in the body's units. */
function charIds(doc: Y.Doc, quote: string): string[] {
  const { text, units } = liveUnits(doc);
  const at = text.indexOf(quote);
  expect(at, `"${quote}" is in the body`).toBeGreaterThanOrEqual(0);
  return units.slice(at, at + quote.length).map(({ item, off }) => `${item.id.client}:${item.id.clock + off}`);
}

/** Types `text` into `doc` right after the first occurrence of `after`, as a person in the editor would. */
function typeAfter(doc: Y.Doc, after: string, text: string): void {
  let found = false;
  serverWrite(doc, 'peer', () => {
    const visit = (node: LexicalNode): boolean => {
      if ($isTextNode(node) && node.getTextContent().includes(after)) {
        node.setTextContent(node.getTextContent().replace(after, `${after}${text}`));
        return true;
      }
      return $isElementNode(node) && node.getChildren().some(visit);
    };
    found = visit($getRoot());
  });
  expect(found, `"${after}" is in the doc`).toBe(true);
}

const BODY = ['Alpha one stays.', 'Bravo two stays.', 'Charlie three changes.', 'Delta four stays.', 'Echo five stays.'].join('\n\n');

describe('T7.2 structural push merge @p:agt-1 @p:tech-5', () => {
  it('lands an undrifted push exactly, and every untouched block keeps its Yjs item', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const before = blockIds(live);
    const next = base.replace('Charlie three changes.', 'Charlie three has changed.');
    const result = landPush(live, NOTE, { base, newText: next, force: false }, PUSH);
    expect(result).toMatchObject({ ok: true, failedHunks: [] });
    expect(exported(live)).toBe(next);
    const after = blockIds(live);
    expect(after).toHaveLength(5);
    for (const index of [0, 1, 3, 4]) expect(after[index], `block ${index} keeps its item`).toBe(before[index]);
  });

  it('merges a drifted doc: a peer\'s edit to another block and the push both land', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const peer = fork(live);
    typeAfter(peer, 'Alpha one', ' (peer)');
    share(peer, live);
    const next = base.replace('Delta four stays.', 'Delta four was pushed.');
    const result = landPush(live, NOTE, { base, newText: next, force: false }, PUSH);
    expect(result).toMatchObject({ ok: true, failedHunks: [] });
    const text = exported(live);
    expect(text).toContain('Alpha one (peer) stays.');
    expect(text).toContain('Delta four was pushed.');
  });

  it('keeps a peer\'s concurrent typing in the same paragraph: both the push and the typing survive', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const peer = fork(live);
    const kept = charIds(live, 'three');
    // The push edits the start of the paragraph while the peer types at its end, concurrently.
    const next = base.replace('Charlie three changes.', 'Charles three changes.');
    typeAfter(peer, 'three changes', ' while typing');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true });
    share(peer, live);
    share(live, peer);
    expect(exported(live)).toContain('Charles three changes while typing.');
    expect(exported(peer)).toBe(exported(live));
    expect(charIds(live, 'three'), 'the untouched characters keep their items').toEqual(kept);
  });

  it('keeps a peer\'s typing inside a span the push deletes, and returns that hunk as failed', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const peer = fork(live);
    typeAfter(peer, 'Charlie three', ' (peer)');
    share(peer, live);
    const next = base.replace('Charlie three changes.', 'Charlie.').replace('Echo five stays.', 'Echo five was pushed.');
    const result = landPush(live, NOTE, { base, newText: next, force: false }, PUSH);
    expect(result.ok).toBe(true);
    expect((result as { failedHunks: string[] }).failedHunks).toHaveLength(1);
    expect(exported(live)).toContain('Charlie three (peer) changes.');
    expect(exported(live)).toContain('Echo five was pushed.');
  });

  it('keeps duplicate blocks in their positions: an edit to the second of three equal paragraphs lands on the second', () => {
    const live = docOf(['Same line.', 'Same line.', 'Same line.', 'Tail.'].join('\n\n'));
    const base = exported(live);
    const before = blockIds(live);
    const next = ['Same line.', 'Same line, edited.', 'Same line.', 'Tail.'].join('\n\n');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true });
    expect(exported(live)).toBe(next);
    const after = blockIds(live);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBe(before[3]);
  });

  it('keeps duplicate blocks in their positions when the doc drifted above them', () => {
    const live = docOf(['Same line.', 'Same line.', 'Same line.', 'Tail.'].join('\n\n'));
    const base = exported(live);
    const peer = fork(live);
    typeAfter(peer, 'Tail', ' end');
    share(peer, live);
    const next = ['Same line.', 'Same line.', 'Same line, third.', 'Tail.'].join('\n\n');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
    expect(exported(live)).toBe(['Same line.', 'Same line.', 'Same line, third.', 'Tail end.'].join('\n\n'));
  });

  it('splits :::tabs correctly: an edit inside a panel keeps the tabs one block, and the blocks around it keep their items', () => {
    const tabs = [':::tabs', '=== Option A', 'Content for A.', '', '=== Option B', 'Content for B.', '', ':::'].join('\n');
    const live = docOf(['Before the tabs.', tabs, 'After the tabs.'].join('\n\n'));
    const base = exported(live);
    expect(base).toContain('=== Option B');
    const before = blockIds(live);
    expect(before).toHaveLength(3);
    const peer = fork(live);
    typeAfter(peer, 'Before the', ' shared');
    share(peer, live);
    const next = base.replace('Content for B.', 'Content for B, pushed.').replace('After the tabs.', 'After the tabs, pushed.');
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
    const text = exported(live);
    expect(text).toContain('Before the shared tabs.');
    expect(text).toContain('=== Option A\nContent for A.');
    expect(text).toContain('=== Option B\nContent for B, pushed.');
    expect(text).toContain('After the tabs, pushed.');
    const after = blockIds(live);
    expect(after, 'still three blocks: the tabs did not fragment').toHaveLength(3);
    expect(after[0]).toBe(before[0]);
  });

  it('refuses a degenerate push unless forced, drifted or not, and an empty file is degenerate', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const kept = exported(live);
    const most = 'Alpha one stays.';
    const refused = landPush(live, NOTE, { base, newText: most, force: false }, PUSH);
    expect(refused).toMatchObject({ ok: false, reason: 'degenerate' });
    expect((refused as { deletedRatio: number }).deletedRatio).toBeGreaterThan(0.6);
    expect(exported(live), 'nothing landed').toBe(kept);
    expect(landPush(live, NOTE, { base, newText: '', force: false }, PUSH)).toMatchObject({ ok: false, reason: 'degenerate' });
    expect(exported(live)).toBe(kept);
    expect(landPush(live, NOTE, { base, newText: most, force: true }, PUSH)).toMatchObject({ ok: true });
    expect(exported(live)).toBe(most);
  });

  it('returns a hunk it cannot place and lands the rest', () => {
    const body = BODY.replace('Charlie three changes.', 'Charlie wrote a long and quite distinctive sentence about winter squash.');
    const live = docOf(body);
    const base = exported(live);
    // A person deleted the paragraph the push edits, so the push's hunk has nowhere to go.
    const deleted = docOf(body.replace('Charlie wrote a long and quite distinctive sentence about winter squash.\n\n', ''));
    expect(landPush(live, NOTE, { base, newText: exported(deleted), force: true }, 'setup')).toMatchObject({ ok: true });
    const next = base.replace('quite distinctive sentence', 'rather peculiar sentence').replace('Echo five stays.', 'Echo five was pushed.');
    const result = landPush(live, NOTE, { base, newText: next, force: false }, PUSH);
    expect(result.ok).toBe(true);
    expect((result as { failedHunks: string[] }).failedHunks.length).toBeGreaterThan(0);
    expect(exported(live)).toContain('Echo five was pushed.');
    expect(exported(live)).not.toContain('peculiar');
  });

  it('normalizes CRLF and lands frontmatter changes with the body', () => {
    const live = docOf('Body text.');
    const base = exported(live);
    const next = '---\r\nstatus: draft\r\n---\r\nBody text, pushed.';
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true });
    expect(readFrontmatter(live)).toEqual({ status: 'draft' });
    expect(exported(live)).toContain('Body text, pushed.');
    expect(exported(live)).not.toContain('\r');
  });

  it('a no-op push writes nothing', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const vector = Y.encodeStateVector(live);
    expect(landPush(live, NOTE, { base, newText: base, force: false }, PUSH)).toMatchObject({ ok: true, applied: 0 });
    expect(Y.encodeStateVector(live)).toEqual(vector);
  });

  it('a refused admission writes nothing', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const vector = Y.encodeStateVector(live);
    expect(() => landPush(live, NOTE, { base, newText: `${base}\n\nMore.`, force: false }, PUSH, () => {
      throw new Error('doc-cap');
    })).toThrow('doc-cap');
    expect(Y.encodeStateVector(live)).toEqual(vector);
  });

  it('keeps typing at the end of the last paragraph in that paragraph when the pushed file ends with a newline', () => {
    const live = docOf(BODY);
    const base = exported(live);
    const peer = fork(live);
    typeAfter(peer, 'Echo five stays', ' and more');
    share(peer, live);
    const next = `${base.replace('Echo five stays.', 'Echo five still stays.')}\n`;
    expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
    expect(exported(live).endsWith('\n\nEcho five still stays and more.')).toBe(true);
  });

  // The converter's NOT_IDEMPOTENT fixtures: a re-import of their export differs from the first import.
  const LOSSY: Record<string, string> = {
    'code-blocks': 'Intro.\n\n````markdown\n```js\ninner fence\n```\n````\n\nOutro.',
    entities: 'Entities stay literal: &#160; and &amp; and &lt;tag&gt;.\n\nA non-breaking space between words.',
  };
  for (const [name, markdown] of Object.entries(LOSSY)) {
    it(`leaves untouched blocks the converter would not re-import exactly alone (${name})`, () => {
      const live = docOf(markdown);
      const base = exported(live);
      const before = bodyState(live).root.children;
      const ids = blockIds(live);
      const next = `${base}\n\nA pushed paragraph.`;
      expect(landPush(live, NOTE, { base, newText: next, force: false }, PUSH)).toMatchObject({ ok: true, failedHunks: [] });
      const after = bodyState(live).root.children;
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(blockIds(live).slice(0, ids.length)).toEqual(ids);
      expect(exported(live)).toBe(next);
    });
  }
});
