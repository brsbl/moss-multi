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
});
