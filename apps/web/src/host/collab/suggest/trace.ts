// Where each struck item stands in a suggester's editor, carried through Lexical's own text operations
// (docs/design/suggestions.md §5). A native rewrite (a join, an unwrap, a paste, a retyped block) moves text between
// nodes by splitting, merging, splicing and replacing them, and the binding then writes the moved text under new ids.
// Following each struck character through those operations says which new item stands for which struck original,
// from the editor's own data: no prediction of Lexical's behaviour, and no match on character values.
import {
  $getEditor, $getSelection, $hasUpdateTag, $isRangeSelection, $isTextNode, COLLABORATION_TAG, TextNode,
  type EditorState, type LexicalEditor, type LexicalNode, type NodeKey,
} from 'lexical';
import type * as Y from 'yjs';

/** A struck original and where it stands: a text node and an offset in it, or a line break or decorator (offset -1). */
export interface Spot {
  id: Y.ID;
  key: NodeKey;
  offset: number;
}

interface Tracer {
  read: () => Spot[];
  /** The editor state `spots` describe: the pending one while an update runs. */
  state: EditorState | null;
  spots: Spot[];
}

const tracers = new WeakMap<LexicalEditor, Tracer>();
/** Inside a traced operation: the operations it calls are accounted for by it. */
let depth = 0;

const pendingOf = (editor: LexicalEditor) => (editor as unknown as { _pendingEditorState: EditorState | null })._pendingEditorState;

/** The tracer of the editor being updated; its spots are read from the binding at the update's first text operation. */
function active(): Tracer | null {
  if (depth > 0) return null;
  let editor: LexicalEditor;
  try {
    editor = $getEditor();
  } catch {
    return null;
  }
  const tracer = tracers.get(editor);
  const pending = pendingOf(editor);
  if (!tracer || !pending) return null;
  // The binding applying Yjs changes (a peer's, an undo's): it writes no copies, and its reads are already current.
  // Read only, never set: the binding tags an undo manager's changes this way.
  // eslint-disable-next-line moss/no-historic-tag
  if ($hasUpdateTag(COLLABORATION_TAG) || $hasUpdateTag('historic')) {
    tracer.state = null;
    return null;
  }
  if (tracer.state !== pending) {
    tracer.spots = tracer.read();
    tracer.state = pending;
  }
  return tracer;
}

/** Moves the text spots in `key` to where `to` says, dropping those it deletes. */
function move(tracer: Tracer, key: NodeKey, to: (offset: number) => { key: NodeKey; offset: number } | null): void {
  tracer.spots = tracer.spots.flatMap((spot) => {
    if (spot.key !== key || spot.offset < 0) return [spot];
    const next = to(spot.offset);
    return next ? [{ id: spot.id, ...next }] : [];
  });
}

/**
 * Offsets of `before` in `after` when one run of characters changed, split as the binding splits it
 * (@lexical/yjs simpleDiffWithCursor): the common head up to the caret, then the common tail, then the rest of the head.
 */
function remap(before: string, after: string, cursor: number): (offset: number) => number | null {
  let head = 0;
  let tail = 0;
  while (head < before.length && head < after.length && before[head] === after[head] && head < cursor) head += 1;
  while (tail + head < before.length && tail + head < after.length && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  while (tail + head < before.length && tail + head < after.length && before[head] === after[head]) head += 1;
  return (offset) => (offset < head ? offset : offset >= before.length - tail ? offset + after.length - before.length : null);
}

/** The caret the binding diffs `node`'s text around: a collapsed selection in it, else its end. */
function $cursorIn(node: LexicalNode, length: number): number {
  const selection = $getSelection();
  return $isRangeSelection(selection) && selection.isCollapsed() && selection.anchor.key === node.getKey() ? selection.anchor.offset : length;
}

function traced<T>(run: () => T): T {
  depth += 1;
  try {
    return run();
  } finally {
    depth -= 1;
  }
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  const text = TextNode.prototype;
  const { splitText, mergeWithSibling, spliceText, setTextContent } = text;
  // LexicalNode is exported as a type only; TextNode extends it directly.
  const base = Object.getPrototypeOf(text) as LexicalNode;
  const { replace } = base;

  text.splitText = function (this: TextNode, ...offsets: number[]): TextNode[] {
    const tracer = active();
    const key = this.getKey();
    const parts = traced(() => splitText.apply(this, offsets));
    if (tracer && parts.length > 1) {
      const ranges: { key: NodeKey; start: number; end: number }[] = [];
      let start = 0;
      for (const part of parts) {
        const end = start + part.getTextContentSize();
        ranges.push({ key: part.getKey(), start, end });
        start = end;
      }
      move(tracer, key, (offset) => {
        const range = ranges.find(({ start: from, end }) => offset >= from && offset < end);
        return range ? { key: range.key, offset: offset - range.start } : null;
      });
    }
    return parts;
  };

  text.mergeWithSibling = function (this: TextNode, target: TextNode): TextNode {
    const tracer = active();
    // As Lexical decides it: `target` before this node, or after it.
    const before = target === this.getPreviousSibling();
    const self = this.getKey();
    const other = target.getKey();
    const selfSize = this.getTextContentSize();
    const otherSize = target.getTextContentSize();
    const merged = traced(() => mergeWithSibling.call(this, target));
    if (tracer) {
      const into = merged.getKey();
      move(tracer, other, (offset) => ({ key: into, offset: before ? offset : offset + selfSize }));
      move(tracer, self, (offset) => ({ key: into, offset: before ? offset + otherSize : offset }));
    }
    return merged;
  };

  text.spliceText = function (this: TextNode, offset: number, delCount: number, newText: string, moveSelection?: boolean): TextNode {
    const tracer = active();
    const key = this.getKey();
    // Lexical's own reading of a negative offset.
    let index = offset;
    if (index < 0) index = Math.max(0, newText.length + index);
    const result = traced(() => spliceText.call(this, offset, delCount, newText, moveSelection));
    if (tracer) {
      move(tracer, key, (at) => {
        if (at < index) return { key, offset: at };
        return at < index + delCount ? null : { key, offset: at - delCount + newText.length };
      });
    }
    return result;
  };

  text.setTextContent = function (this: TextNode, next: string): TextNode {
    const tracer = active();
    const key = this.getKey();
    const before = this.getTextContent();
    const result = traced(() => setTextContent.call(this, next));
    if (tracer && before !== next) {
      const map = remap(before, next, $cursorIn(this, next.length));
      move(tracer, key, (offset) => {
        const at = map(offset);
        return at === null ? null : { key, offset: at };
      });
    }
    return result;
  } as TextNode['setTextContent'];

  const replaceNode = replace as (this: LexicalNode, replaceWith: LexicalNode, includeChildren?: boolean) => LexicalNode;
  base.replace = function (this: LexicalNode, replaceWith: LexicalNode, includeChildren?: boolean): LexicalNode {
    const tracer = active();
    const key = this.getKey();
    const before = $isTextNode(this) ? this.getTextContent() : null;
    const result = traced(() => replaceNode.call(this, replaceWith, includeChildren));
    const into = result.getKey();
    if (tracer && into !== key) {
      if (before === null) {
        tracer.spots = tracer.spots.map((spot) => (spot.key === key && spot.offset < 0 ? { ...spot, key: into } : spot));
      } else {
        const map = $isTextNode(result) ? remap(before, result.getTextContent(), $cursorIn(result, result.getTextContentSize())) : () => null;
        move(tracer, key, (offset) => {
          const at = map(offset);
          return at === null ? null : { key: into, offset: at };
        });
      }
    }
    return result;
  } as LexicalNode['replace'];
}

export interface StrikeTrace {
  /** Before the binding writes a commit: the spots as of that commit (read now if no text operation ran in it). */
  settle(): void;
  /** The settled spots, once: the next update reads afresh. */
  take(): Spot[];
  /** Struck mid-update: their spots join the ones being carried. */
  add(spots: readonly Spot[]): void;
  stop(): void;
}

/** Traces `editor`'s struck items; `read` lists where they stand now, by the binding (before it writes an update). */
export function traceStrikes(editor: LexicalEditor, read: () => Spot[]): StrikeTrace {
  install();
  const tracer: Tracer = { read, state: null, spots: [] };
  tracers.set(editor, tracer);
  return {
    settle() {
      const state = editor.getEditorState();
      if (tracer.state === state) return;
      tracer.spots = read();
      tracer.state = state;
    },
    take() {
      const { spots } = tracer;
      tracer.spots = [];
      tracer.state = null;
      return spots;
    },
    add(spots) {
      if (tracer.state && tracer.state === pendingOf(editor)) tracer.spots.push(...spots);
    },
    stop() {
      if (tracers.get(editor) === tracer) tracers.delete(editor);
    },
  };
}
