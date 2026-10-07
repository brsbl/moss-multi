// Comment paint (SP10; docs/design/comments.md §11): derived, never in the doc. In the same task as every editor
// update that moves text, and one animation frame after a comments or filter change, a pass resolves each anchored
// root's positions to Lexical points, then to a DOM Range, and replaces the ranges of the named CSS Custom Highlights (`moss-comment-<color>`, and the `-hover-` and
// `-active-` underlines). A live Range collapses when Lexical rewrites a text node, so ranges are rebuilt, never kept.
// `CSS.highlights` is global, so one registry merges every pane's ranges into each name. Decorators take moss's
// classes on their `[data-block-decorator-key]` wrapper instead. No MarkNode and no `__commentIds` reach the tree.
import { $getAnchorAndFocusForUserState, type Binding, type UserState } from '@lexical/yjs';
import { fromBase64 } from '@moss-multi/core/tree-anchor';
import type { Anchor } from '@moss-multi/core/anchor-frame';
import { commentThreadFilterAtom } from '@moss/shared/state/note-atoms';
import { getDefaultStore } from 'jotai';
import { $getNodeByKey, $isDecoratorNode, $isElementNode, $isTextNode, type LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { colorOf } from './atoms.ts';
import { liveItem, modelFor, type CommentsModel } from './model.ts';

const COLORS = [0, 3, 4] as const;

export interface Painted {
  color: number;
  ranges: Range[];
  /** The Lexical key of the node the comment starts in (a decorator's own key for a block comment). */
  key: string;
  /** A block comment's decorator wrapper. */
  block: HTMLElement | null;
}

const supported = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

class Painter {
  painted = new Map<string, Painted>();
  hover: string | null = null;
  active: string | null = null;
  #frame: number | null = null;
  readonly model: CommentsModel;

  constructor(readonly editor: LexicalEditor, readonly binding: Binding) {
    this.model = modelFor(binding.doc);
  }

  get docId(): string {
    return this.binding.id;
  }

  schedule = (): void => {
    if (this.#frame !== null || typeof requestAnimationFrame === 'undefined') return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.paint();
    });
  };

  cancel(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  paint(): void {
    const next = new Map<string, Painted>();
    const records = this.model.records();
    const filter = getDefaultStore().get(commentThreadFilterAtom(this.docId));
    const root = this.editor.getRootElement();
    if (root) {
      this.editor.getEditorState().read(() => {
        for (const id of this.model.anchoredRoots()) {
          const record = records.get(id);
          const anchor = this.model.anchor(id);
          if (!record || record.parentId !== undefined || anchor?.status !== 'anchored') continue;
          const resolved = record.resolvedAt !== undefined;
          if ((filter === 'open' && resolved) || (filter === 'resolved' && !resolved)) continue;
          const painted = this.#resolve(anchor, root);
          if (painted) next.set(id, { ...painted, color: colorOf(record) });
        }
      });
    }
    this.painted = next;
    refreshHighlights();
    notifyPaint(this.editor);
  }

  /** The DOM range (or decorator wrapper) of an anchored record, or null while it does not resolve in this editor. */
  #resolve(anchor: Anchor, root: HTMLElement): Omit<Painted, 'color'> | null {
    const doc = this.binding.doc;
    const start = liveItem(doc, anchor.start);
    const end = liveItem(doc, anchor.end);
    if (!start || !end) return null;
    if (anchor.kind === 'block') {
      const type = start.content instanceof Y.ContentType ? (start.content.type as Y.AbstractType<unknown> & { _collabNode?: { _key: string } }) : null;
      const key = type?._collabNode?._key;
      if (!key) return null;
      const block = root.querySelector<HTMLElement>(`[data-block-decorator-key="${CSS.escape(key)}"]`) ?? this.editor.getElementByKey(key);
      return block ? { ranges: [], key, block } : null;
    }
    const state = { anchorPos: decode(anchor.start), focusPos: decode(anchor.end) } as unknown as UserState;
    const points = $getAnchorAndFocusForUserState(this.binding, state);
    if (points.anchorKey === null || points.focusKey === null) return null;
    const from = domPoint(this.editor, points.anchorKey, points.anchorOffset, false);
    const to = domPoint(this.editor, points.focusKey, points.focusOffset, true);
    if (!from || !to) return null;
    const range = document.createRange();
    try {
      range.setStart(from[0], from[1]);
      range.setEnd(to[0], to[1]);
    } catch {
      return null;
    }
    return range.collapsed ? null : { ranges: [range], key: points.anchorKey, block: null };
  }
}

const decode = (value: string) => Y.decodeRelativePosition(fromBase64(value));

/**
 * A point from @lexical/yjs as a DOM position: a text node's character offset, an element's child offset, or the
 * edge of an inline decorator (whose offset the binding reports in Yjs units, so its node index is used instead).
 */
function domPoint(editor: LexicalEditor, key: string, offset: number, end: boolean): [Node, number] | null {
  const node = $getNodeByKey(key);
  if (!node) return null;
  if ($isTextNode(node)) {
    let text: Node | null = editor.getElementByKey(key);
    while (text && text.nodeType !== Node.TEXT_NODE) text = text.firstChild;
    return text ? [text, Math.min(offset, text.textContent?.length ?? 0)] : null;
  }
  if ($isDecoratorNode(node)) {
    const element = editor.getElementByKey(key);
    const parent = element?.parentNode;
    if (!element || !parent) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, element) as number;
    return [parent, end ? index + 1 : index];
  }
  if ($isElementNode(node)) {
    const element = editor.getElementByKey(key);
    return element ? [element, Math.min(offset, element.childNodes.length)] : null;
  }
  return null;
}

const painters = new Map<LexicalEditor, Painter>();

/** Rebuilds every named highlight from every pane's painted ranges. */
function refreshHighlights(): void {
  if (!supported()) return;
  const sets = new Map<string, Range[]>();
  const add = (name: string, ranges: Range[]) => {
    const into = sets.get(name);
    if (into) for (const range of ranges) into.push(range);
  };
  for (const color of COLORS) for (const kind of ['', 'hover-', 'active-']) sets.set(`moss-comment-${kind}${color}`, []);
  for (const painter of painters.values()) {
    for (const [id, entry] of painter.painted) {
      add(`moss-comment-${entry.color}`, entry.ranges);
      if (painter.hover === id) add(`moss-comment-hover-${entry.color}`, entry.ranges);
      if (painter.active === id) add(`moss-comment-active-${entry.color}`, entry.ranges);
      entry.block?.classList.toggle('comment-highlight-active', painter.active === id);
      entry.block?.classList.toggle('comment-decorator-hover', painter.hover === id);
    }
  }
  for (const [name, ranges] of sets) {
    if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
    else CSS.highlights.delete(name);
  }
}

/**
 * Paints `editor`'s comments while its binding lives (the collaboration plugin's seam calls this with the binding it
 * made). Returns the stop.
 */
export function bindCommentPaint(editor: LexicalEditor, binding: Binding): () => void {
  painters.get(editor)?.cancel();
  const painter = new Painter(editor, binding);
  painters.set(editor, painter);
  const stops = [
    // An update that moved text repaints at once, after the binding's own listener synced it to Yjs and before the
    // browser renders: Lexical rewrites a text node's data, which collapses the ranges painted on it, so a deferred
    // pass would leave a frame without the highlight. A selection-only update moves no text.
    editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      painter.cancel();
      painter.paint();
    }),
    painter.model.subscribe(painter.schedule),
    getDefaultStore().sub(commentThreadFilterAtom(binding.id), painter.schedule),
  ];
  painter.schedule();
  return () => {
    for (const stop of stops) stop();
    painter.cancel();
    if (painters.get(editor) === painter) {
      painters.delete(editor);
      refreshHighlights();
      notifyPaint(editor);
    }
  };
}

export const painterOf = (editor: LexicalEditor): Painter | undefined => painters.get(editor);

const paintListeners = new Map<LexicalEditor, Set<() => void>>();
const anyPaintListeners = new Set<() => void>();

function notifyPaint(editor: LexicalEditor): void {
  for (const listener of paintListeners.get(editor) ?? []) listener();
  for (const listener of anyPaintListeners) listener();
}

/** Calls `listener` after each paint of any editor, including a binding's start and end. */
export function subscribeAnyPaint(listener: () => void): () => void {
  anyPaintListeners.add(listener);
  return () => {
    anyPaintListeners.delete(listener);
  };
}

/**
 * Editors a pane binds to a shared doc, for the pane's whole life: the painter comes and goes with the collaboration
 * plugin (a resync, another pane holding the doc), and the editor stays shared meanwhile.
 */
const shared = new Map<LexicalEditor, string>();

/** The pane binds `editor` to `docId` until the returned release. */
export function markShared(editor: LexicalEditor, docId: string): () => void {
  shared.set(editor, docId);
  notifyPaint(editor);
  return () => {
    if (shared.get(editor) !== docId) return;
    shared.delete(editor);
    notifyPaint(editor);
  };
}

/** Whether a pane binds `editor` to a shared doc; false for the file-backed editor bundle. */
export const isShared = (editor: LexicalEditor): boolean => shared.has(editor);

/** Whether some editor in this tab is bound to the shared doc `docId`. */
export function noteBound(docId: string): boolean {
  for (const id of shared.values()) if (id === docId) return true;
  return false;
}

/** Calls `listener` after each paint of `editor`, including one whose binding comes later (the gutter re-measures). */
export function subscribePaint(editor: LexicalEditor, listener: () => void): () => void {
  const set = paintListeners.get(editor) ?? new Set<() => void>();
  set.add(listener);
  paintListeners.set(editor, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) paintListeners.delete(editor);
  };
}

/** moss's active-thread underline (the open popover's comment), or none. */
export function setActive(editor: LexicalEditor, id: string | null): void {
  const painter = painters.get(editor);
  if (!painter || painter.active === id) return;
  painter.active = id;
  refreshHighlights();
}

/** moss's hover underline (a hovered gutter icon or highlight), or none. */
export function setHover(editor: LexicalEditor, id: string | null): void {
  const painter = painters.get(editor);
  if (!painter || painter.hover === id) return;
  painter.hover = id;
  refreshHighlights();
}

const contains = (rect: DOMRect, x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/** The comments painted under the viewport point (x, y) in `editor`, by hit-testing their ranges' boxes. */
export function commentsAtPoint(editor: LexicalEditor, x: number, y: number): string[] {
  const painter = painters.get(editor);
  if (!painter) return [];
  const hits: string[] = [];
  for (const [id, entry] of painter.painted) {
    if (entry.block ? contains(entry.block.getBoundingClientRect(), x, y) : entry.ranges.some((range) => [...range.getClientRects()].some((rect) => contains(rect, x, y)))) hits.push(id);
  }
  return hits;
}
