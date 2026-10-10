// @vitest-environment jsdom
// Comment paint's block classes and pointer cost (comments.md §11). A decorator holding several comments takes moss's
// active and hover classes when any of its comments is active or hovered, and loses them when its comments leave the
// paint (a filter, a delete) or the painter unbinds. Hover hit-tests the latest pointer once per animation frame
// against cached geometry, re-measured after a paint, a scroll or a resize, and nothing fires after the stop.
import type { Binding } from '@lexical/yjs';
import { toBase64 } from '@moss-multi/core/tree-anchor';
import { commentThreadFilterAtom } from '@moss/shared/state/note-atoms';
import { getDefaultStore } from 'jotai';
import { createEditor, type LexicalEditor } from 'lexical';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bindCommentPaint, commentsAtPoint, painterOf, setActive, setHover, trackCommentHover, type Painted } from './paint.ts';

const ACTIVE = 'comment-highlight-active';
const HOVER = 'comment-decorator-hover';

let frames: (FrameRequestCallback | null)[] = [];
/** Runs the animation frames queued so far. */
function flushFrames(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback?.(0);
}

class FakeHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges);
  }
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames[handle - 1] = null;
  });
  vi.stubGlobal('CSS', { escape: (value: string) => value, highlights: new Map() });
  vi.stubGlobal('Highlight', FakeHighlight);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top }) as DOMRect;

/** A bound editor whose body holds decorators `keys`, each a block in the doc. */
function fixture(docId: string, keys: string[]) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('root');
  const elements = keys.map(() => new Y.XmlElement('decorator'));
  fragment.insert(0, elements);
  keys.forEach((key, index) => {
    (elements[index] as unknown as { _collabNode: { _key: string } })._collabNode = { _key: key };
  });
  const root = document.createElement('div');
  const blocks = new Map<string, HTMLElement>();
  for (const key of keys) {
    const block = document.createElement('div');
    block.setAttribute('data-block-decorator-key', key);
    root.appendChild(block);
    blocks.set(key, block);
  }
  document.body.appendChild(root);
  const editor = createEditor();
  vi.spyOn(editor, 'getRootElement').mockReturnValue(root);
  const position = (key: string) => {
    const item = elements[keys.indexOf(key)]._item!;
    return toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromJSON({ type: null, tname: null, item: { client: item.id.client, clock: item.id.clock }, assoc: 0 })));
  };
  /** A root comment on the decorator `key`. */
  const comment = (id: string, key: string, resolved = false) => {
    const map = doc.getMap('comments');
    doc.transact(() => {
      map.set(`c:${id}`, { author: 'u1', text: id, createdAt: 1, updatedAt: 1, source: 'user', reactions: {}, ...(resolved ? { resolvedAt: 2 } : {}) });
      map.set(`a:${id}`, { kind: 'block', start: position(key), end: position(key), status: 'anchored', quote: '' });
    });
  };
  const remove = (id: string) => {
    const map = doc.getMap('comments');
    doc.transact(() => {
      map.delete(`c:${id}`);
      map.delete(`a:${id}`);
    });
  };
  return { doc, editor, root, blocks, comment, remove, binding: { doc, id: docId } as unknown as Binding };
}

const classes = (block: HTMLElement | undefined) => ({ active: block?.classList.contains(ACTIVE), hover: block?.classList.contains(HOVER) });

function paint(editor: LexicalEditor): void {
  painterOf(editor)?.paint();
}

for (const [first, second] of [['x1', 'x2'], ['x2', 'x1']] as const) {
  it(`two comments on one block, painted ${first} then ${second}: either one active or hovered keeps the class`, () => {
    const { editor, blocks, comment, binding } = fixture(`doc-order-${first}`, ['k1']);
    comment(first, 'k1');
    comment(second, 'k1');
    const stop = bindCommentPaint(editor, binding);
    paint(editor);
    expect([...(painterOf(editor)?.painted.keys() ?? [])].sort()).toEqual(['x1', 'x2']);
    const block = blocks.get('k1');
    for (const id of ['x1', 'x2']) {
      setActive(editor, id);
      expect(classes(block), `${id} active`).toEqual({ active: true, hover: false });
      setHover(editor, id);
      expect(classes(block), `${id} active and hovered`).toEqual({ active: true, hover: true });
      paint(editor);
      expect(classes(block), `${id}: a repaint keeps both`).toEqual({ active: true, hover: true });
      setActive(editor, null);
      setHover(editor, null);
      expect(classes(block), `${id} released`).toEqual({ active: false, hover: false });
    }
    stop();
  });
}

it('a block whose comments leave the paint loses both classes: filtered out, deleted, or the painter unbound', () => {
  const { editor, blocks, comment, remove, binding } = fixture('doc-leave', ['k1', 'k2', 'k3']);
  comment('open1', 'k1');
  comment('done1', 'k2', true);
  comment('gone1', 'k3');
  const store = getDefaultStore();
  store.set(commentThreadFilterAtom('doc-leave'), 'all');
  const stop = bindCommentPaint(editor, binding);
  paint(editor);

  // Filtering to open threads takes the resolved one out of the paint.
  setActive(editor, 'done1');
  setHover(editor, 'done1');
  expect(classes(blocks.get('k2'))).toEqual({ active: true, hover: true });
  store.set(commentThreadFilterAtom('doc-leave'), 'open');
  paint(editor);
  expect(painterOf(editor)?.painted.has('done1'), 'filtered out').toBe(false);
  expect(classes(blocks.get('k2')), 'a filtered-out block keeps no class').toEqual({ active: false, hover: false });
  store.set(commentThreadFilterAtom('doc-leave'), 'all');

  // A deleted comment leaves its block bare.
  setActive(editor, 'gone1');
  setHover(editor, 'gone1');
  expect(classes(blocks.get('k3'))).toEqual({ active: true, hover: true });
  remove('gone1');
  paint(editor);
  expect(classes(blocks.get('k3')), 'a deleted comment leaves no class').toEqual({ active: false, hover: false });

  // Unbinding the painter clears what it set.
  setActive(editor, 'open1');
  setHover(editor, 'open1');
  expect(classes(blocks.get('k1'))).toEqual({ active: true, hover: true });
  stop();
  expect(classes(blocks.get('k1')), 'an unbound painter leaves no class').toEqual({ active: false, hover: false });
});

/** 2,000 painted text ranges in a row, each counting its rect reads. */
function manyRanges(editor: LexicalEditor, count: number, offset = { x: 0 }) {
  const reads = { count: 0 };
  const painted = new Map<string, Painted>();
  for (let i = 0; i < count; i += 1) {
    const range = {
      getClientRects: () => {
        reads.count += 1;
        return [rect(offset.x + i * 10, 0, 10, 10)];
      },
    } as unknown as Range;
    painted.set(`r${i}`, { color: 0, ranges: [range], key: `t${i}`, block: null });
  }
  const painter = painterOf(editor);
  if (!painter) throw new Error('no painter');
  painter.painted = painted;
  return reads;
}

const move = (root: HTMLElement, x: number, y: number) => root.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));

it('with 2,000 painted ranges, many pointer moves in one frame hit-test once, and a stable frame reads no rects', () => {
  const { editor, root, binding } = fixture('doc-hover', []);
  const stop = bindCommentPaint(editor, binding);
  flushFrames();
  const reads = manyRanges(editor, 2_000);
  const hits: string[][] = [];
  const untrack = trackCommentHover(editor, root, (ids) => hits.push(ids));

  for (let i = 0; i < 100; i += 1) move(root, 5 + i, 5);
  expect(hits, 'nothing before the frame').toEqual([]);
  flushFrames();
  expect(hits, 'one hit-test for the frame, at the latest point').toEqual([['r10']]);
  const measured = reads.count;
  expect(measured, 'one measure of every range').toBeLessThanOrEqual(2_000);

  for (let i = 0; i < 100; i += 1) move(root, 25 + i, 5);
  flushFrames();
  expect(hits.at(-1)).toEqual(['r12']);
  expect(reads.count - measured, 'a stable frame reads no rects').toBe(0);
  untrack();
  stop();
});

it('hover stays right after an edit, a scroll, a resize and a filter change, and nothing fires after the stop', () => {
  const { editor, root, blocks, comment, binding } = fixture('doc-hover-2', ['k1']);
  comment('b1', 'k1');
  const stop = bindCommentPaint(editor, binding);
  paint(editor);
  const block = blocks.get('k1')!;
  let box = rect(0, 0, 100, 20);
  const measure = vi.spyOn(block, 'getBoundingClientRect').mockImplementation(() => box);
  expect(commentsAtPoint(editor, 50, 10)).toEqual(['b1']);
  const reads = measure.mock.calls.length;
  expect(commentsAtPoint(editor, 50, 10)).toEqual(['b1']);
  expect(measure.mock.calls.length, 'a stable layout is not re-measured').toBe(reads);

  // An edit moves the block: the repaint invalidates the cache.
  box = rect(0, 100, 100, 20);
  paint(editor);
  expect(commentsAtPoint(editor, 50, 10), 'after an edit').toEqual([]);
  expect(commentsAtPoint(editor, 50, 110)).toEqual(['b1']);

  // A scroll moves it in the viewport.
  box = rect(0, 40, 100, 20);
  window.dispatchEvent(new Event('scroll'));
  expect(commentsAtPoint(editor, 50, 50), 'after a scroll').toEqual(['b1']);

  // A resize reflows it.
  box = rect(200, 40, 100, 20);
  window.dispatchEvent(new Event('resize'));
  expect(commentsAtPoint(editor, 50, 50), 'after a resize').toEqual([]);
  expect(commentsAtPoint(editor, 250, 50)).toEqual(['b1']);

  // A filter change repaints without it.
  getDefaultStore().set(commentThreadFilterAtom('doc-hover-2'), 'resolved');
  flushFrames();
  expect(commentsAtPoint(editor, 250, 50), 'after a filter change').toEqual([]);
  getDefaultStore().set(commentThreadFilterAtom('doc-hover-2'), 'open');
  flushFrames();

  const hits: string[][] = [];
  const untrack = trackCommentHover(editor, root, (ids) => hits.push(ids));
  move(root, 250, 50);
  untrack();
  flushFrames();
  move(root, 250, 50);
  flushFrames();
  expect(hits, 'a stopped tracker never fires, even for a move already queued').toEqual([]);

  const again = trackCommentHover(editor, root, (ids) => hits.push(ids));
  stop();
  move(root, 250, 50);
  flushFrames();
  expect(hits, 'an unbound painter hit-tests nothing').toEqual([[]]);
  again();
});
