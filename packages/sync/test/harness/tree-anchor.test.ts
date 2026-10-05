// T4.0 kept pieces (docs/design/comments.md §4): one projection on every replica, the client's minting arithmetic,
// and the create-time quote search with the round-1 suffix fix.
import { $getRoot, type ElementNode, type TextNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { liveUnits } from '@moss-multi/core/anchor-frame';
import { decodeRelPos, findQuote, positionAt, project, similarity } from '@moss-multi/core/tree-anchor';
import { scene } from './comments-scene.ts';

describe('T4.0 projection, minting and the create-time quote search @p:tech-3', () => {
  it('every replica and the server compute one projection', () => scene((s) => {
    const a = s.peer();
    expect(project(a.doc).text).toBe(project(s.server).text);
    expect(project(s.server).text).toBe('The quick brown fox jumps over the lazy dog.\nSecond paragraph here, a fox too.\nThird.');
    expect(liveUnits(s.server).text).toBe('The quick brown fox jumps over the lazy dog.Second paragraph here, a fox too.Third.');
  }));

  it('a client mints the same positions from a Lexical point through its binding as from the projection', () => scene((s) => {
    const a = s.peer();
    const projection = project(a.doc);
    const start = projection.text.indexOf('brown fox');
    const fromProjection = [positionAt(projection, start, 0)!, positionAt(projection, start + 9, -1)!].map((p) => Y.encodeRelativePosition(p));
    const [key, offset] = a.editor.getEditorState().read(() => {
      const text = ($getRoot().getFirstChild() as ElementNode).getFirstChild() as TextNode;
      return [text.getKey(), text.getTextContent().indexOf('brown')] as const;
    });
    const collab = a.binding.collabNodeMap.get(key) as unknown as { _parent: { _xmlText: Y.XmlText }; getOffset: () => number };
    const fromPoint = (at: number, assoc: number) =>
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(collab._parent._xmlText, collab.getOffset() + 1 + at, assoc));
    expect(fromPoint(offset, 0)).toEqual(fromProjection[0]);
    expect(fromPoint(offset + 9, -1)).toEqual(fromProjection[1]);
    const comment = s.comment('c1', 'brown fox');
    expect(decodeRelPos(comment.start).item).toEqual(Y.decodeRelativePosition(fromProjection[0]).item);
    expect(decodeRelPos(comment.end).item).toEqual(Y.decodeRelativePosition(fromProjection[1]).item);
  }));

  it('similarity counts the common prefix and suffix, so one typed character barely moves it', () => {
    expect(similarity('brown fox', 'bXrown fox')).toBeGreaterThan(0.9);
    expect(similarity('brown fox', 'brown foXx')).toBeGreaterThan(0.9);
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('the quote search needs a unique best match and short quotes need their context', () => {
    const text = 'TODO: fix this\nTODO: fix this\nTail.';
    expect(findQuote(text, { exact: 'TODO: fix this', prefix: '', suffix: '' }).ambiguous).toBe(true);
    expect(findQuote(text, { exact: 'TODO: fix this', prefix: 'TODO: fix this\n', suffix: '\nTail.' }).range).toEqual({ start: 15, end: 29 });
    expect(findQuote('a fox and a fox', { exact: 'fox', prefix: 'zzz ', suffix: '' }).range).toBeNull();
  });

  it('quote-context-is-bounded: only QUOTE_CONTEXT characters of a caller prefix or suffix are compared', () => {
    const near = 'abcdefghijklmnopqrstuvwxyz012345';
    const junk = 'junk'.repeat(492);
    // The first X has the quote's last 32 prefix characters; the second has the 1,968 before them.
    const text = `${near}X ${junk}${'9'.repeat(32)}X`;
    expect(findQuote(text, { exact: 'X', prefix: `${junk}${near}`, suffix: '' }).range).toEqual({ start: 32, end: 33 });
    const after = `X${near}${'#'.repeat(2_000)}X${'9'.repeat(32)}${junk}`;
    expect(findQuote(after, { exact: 'X', prefix: '', suffix: `${near}${junk}` }).range).toEqual({ start: 0, end: 1 });
  });

  it('quote-matches-are-bounded: past 1,000 occurrences the search stops and answers ambiguous', () => {
    const text = `${'.X'.repeat(1_100)} unique-left X unique-right`;
    expect(findQuote(text, { exact: 'X', prefix: ' unique-left ', suffix: ' unique-right' })).toEqual({ range: null, ambiguous: true });
    const few = `${'.X'.repeat(900)} unique-left X unique-right`;
    expect(findQuote(few, { exact: 'X', prefix: ' unique-left ', suffix: ' unique-right' }).range).toEqual({ start: 1_813, end: 1_814 });
  });
});
