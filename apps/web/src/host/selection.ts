// The reader's selection in a moss note body, as the viewer's and the editor's `selection()` return it (feature
// `selection-1`). Moss markdown has no persisted block ids, so a selection is referenced by its lines in the note file
// and its heading path. The lines come from the export a save writes: moss's transformers and post-export steps,
// which each package passes in, run once on the body and once per top-level block to place each block in it.
import { $isTableSelection } from '@lexical/table';
import { $createRangeSelectionFromDom, $getNearestNodeFromDOMNode, $getRoot, $getSelection, $isDecoratorNode, $isElementNode, type ElementNode, type LexicalEditor, type LexicalNode } from 'lexical';
import { $convertToMarkdownString, type Transformer } from '@lexical/markdown';

/** Same shape as the viewer's and the editor's `MossSelection`. */
export interface MossSelection {
  text: string;
  markdown: string;
  lines: { start: number; end: number };
  headings: string[];
  blocks: { type: string; line: number; heading?: string }[];
}

export interface MossExport {
  transformers: Transformer[];
  /** Moss's steps after the Lexical export, as a save runs them on the body. */
  finish(markdown: string): string;
  stripMarkers(markdown: string): string;
}

interface Point {
  node: Node;
  offset: number;
}

interface BodyRange {
  start: Point;
  end: Point;
  /** The selected text when the DOM gives it directly (a code block's textarea), else null. */
  field: string | null;
  range: Range | null;
}

/** The selection clamped to the editor root, null when it is collapsed or outside it, 'none' when the page has none. */
function bodyRange(root: HTMLElement): BodyRange | null | 'none' {
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  if (active instanceof HTMLTextAreaElement && root.contains(active)) {
    const { selectionStart: from, selectionEnd: to, value } = active;
    if (from === to) return null;
    return { start: { node: active, offset: from }, end: { node: active, offset: to }, field: value.slice(from, to), range: null };
  }
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0) return 'none';
  if (selection.isCollapsed) return null;
  const selected = selection.getRangeAt(0);
  const body = doc.createRange();
  body.selectNodeContents(root);
  let from: number;
  let to: number;
  try {
    from = body.comparePoint(selected.startContainer, selected.startOffset);
    to = body.comparePoint(selected.endContainer, selected.endOffset);
  } catch {
    return null;
  }
  if (from > 0 || to < 0) return null;
  const range = doc.createRange();
  if (from === 0) range.setStart(selected.startContainer, selected.startOffset);
  else range.setStart(root, 0);
  if (to === 0) range.setEnd(selected.endContainer, selected.endOffset);
  else range.setEnd(root, root.childNodes.length);
  if (range.collapsed) return null;
  return {
    start: { node: range.startContainer, offset: range.startOffset },
    end: { node: range.endContainer, offset: range.endOffset },
    field: null,
    range,
  };
}

/** The DOM node a boundary point sits in or before (start) or after (end). */
function pointNode(point: Point, side: 'start' | 'end'): Node {
  const { node, offset } = point;
  if (node instanceof HTMLTextAreaElement || node.nodeType === Node.TEXT_NODE) return node;
  return node.childNodes[side === 'start' ? offset : offset - 1] ?? node;
}

/** The root child holding a node; table cells and tab panels are shadow roots, so getTopLevelElement stops short. */
function $topLevel(node: LexicalNode): LexicalNode | null {
  const root = $getRoot();
  let current: LexicalNode | null = node;
  while (current) {
    const parent: ElementNode | null = current.getParent();
    if (parent === root) return current;
    current = parent;
  }
  return null;
}

function $blockAt(point: Point, side: 'start' | 'end'): { block: LexicalNode; node: LexicalNode } | null {
  const node = $getNearestNodeFromDOMNode(pointNode(point, side));
  if (!node) return null;
  const root = $getRoot();
  if (node === root) {
    const children = root.getChildren();
    const block = side === 'start' ? children[0] : children[children.length - 1];
    return block ? { block, node: block } : null;
  }
  const block = $topLevel(node);
  return block ? { block, node } : null;
}

/** The body as a save writes it, and each root child's first and last line in it (0-based). */
function $layout(children: LexicalNode[], exp: MossExport): { body: string; spans: [number, number][] } {
  const body = exp.finish($convertToMarkdownString(exp.transformers));
  const breaks: number[] = [];
  for (let i = body.indexOf('\n'); i >= 0; i = body.indexOf('\n', i + 1)) breaks.push(i);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let cursor = 0;
  let last = -1;
  const spans = children.map((child): [number, number] => {
    // The exporter reads only the parent's children, so one block exports exactly as it does inside the body.
    const chunk = exp.finish($convertToMarkdownString(exp.transformers, { getChildren: () => [child] } as unknown as ElementNode));
    const at = chunk ? body.indexOf(chunk, cursor) : -1;
    if (at < 0) {
      // An empty paragraph is the blank line after the block before it.
      const line = Math.max(last + 1, lineOf(cursor) + (cursor > 0 ? 1 : 0));
      last = line;
      return [line, line];
    }
    cursor = at + chunk.length;
    const span: [number, number] = [lineOf(at), lineOf(cursor - 1)];
    last = span[1];
    return span;
  });
  return { body, spans };
}

const isWrapperItem = (node: LexicalNode) =>
  $isElementNode(node) && node.getChildrenSize() > 0 && node.getChildren().every((child) => child.getType() === 'list');

function $ancestorOfType(node: LexicalNode, block: LexicalNode, test: (node: LexicalNode) => boolean): LexicalNode | null {
  for (let current: LexicalNode | null = node; current && current !== block.getParent(); current = current.getParent()) {
    if (test(current)) return current;
  }
  return null;
}

/** The line, within a block's span, that a point sits on; null when only the whole block can be named. */
function $lineIn(editor: LexicalEditor, block: LexicalNode, node: LexicalNode, point: Point, side: 'start' | 'end', count: number): number | null {
  if (count === 1) return 0;
  const type = block.getType();
  if (type === 'list' && $isElementNode(block)) {
    // One line per list item with content of its own; a nested list's wrapper item has none.
    const items: LexicalNode[] = [];
    const walk = (parent: ElementNode) => {
      for (const child of parent.getChildren()) {
        if (child.getType() === 'listitem' && !isWrapperItem(child)) items.push(child);
        if ($isElementNode(child)) walk(child);
      }
    };
    walk(block);
    const item = $ancestorOfType(node, block, (candidate) => candidate.getType() === 'listitem' && !isWrapperItem(candidate));
    const index = item ? items.indexOf(item) : -1;
    return items.length === count && index >= 0 ? index : null;
  }
  if (type === 'table' && $isElementNode(block)) {
    // The header row, the delimiter row, then one line per row.
    const rows = block.getChildren();
    const row = $ancestorOfType(node, block, (candidate) => candidate.getType() === 'tablerow');
    const index = row ? rows.indexOf(row) : -1;
    if (rows.length + 1 !== count || index < 0) return null;
    return index === 0 ? 0 : index + 1;
  }
  const code = codeOf(block);
  if (code !== null && code.split('\n').length + 2 === count) {
    // The fence line, the code's lines, the closing fence.
    const offset = codeOffset(editor, block, code, point);
    if (offset === null) return null;
    // A selection ending at a line's start ends on the line before it.
    const upTo = side === 'end' && offset > 0 && code[offset - 1] === '\n' ? offset - 1 : offset;
    return code.slice(0, upTo).split('\n').length;
  }
  return null;
}

/** A code block's source; moss's CodeBlockNode is a decorator with getCode(). */
function codeOf(block: LexicalNode): string | null {
  const getCode = $isDecoratorNode(block) ? (block as { getCode?: () => string }).getCode : undefined;
  return typeof getCode === 'function' ? getCode.call(block) : null;
}

/**
 * A point's offset in a code block's source: in its open textarea, or in the highlighted lines moss renders
 * (one `.moss-codeblock-line` per source line, without the newlines). Null when the rendering is not the source.
 */
function codeOffset(editor: LexicalEditor, block: LexicalNode, code: string, point: Point): number | null {
  if (point.node instanceof HTMLTextAreaElement) return point.node.value === code ? point.offset : null;
  const element = editor.getElementByKey(block.getKey());
  const from = point.node.nodeType === Node.TEXT_NODE ? point.node.parentElement : (point.node as Element);
  const shown = from?.closest('code');
  if (!element || !shown || !element.contains(shown)) return null;
  const lines = [...shown.querySelectorAll('.moss-codeblock-line')];
  const texts = lines.length ? lines.map((line) => line.textContent ?? '') : [shown.textContent ?? ''];
  if (texts.join('\n') !== code) return null;
  const line = lines.length ? lines.findIndex((candidate) => candidate.contains(point.node)) : 0;
  if (line < 0) return null;
  const before = shown.ownerDocument.createRange();
  before.setStart(lines[line] ?? shown, 0);
  before.setEnd(point.node, point.offset);
  return texts.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + before.toString().length;
}

const cellOf = (node: LexicalNode): LexicalNode | null => $ancestorOfType(node, $getRoot(), (candidate) => candidate.getType() === 'tablecell');
const rowOf = (node: LexicalNode): number => cellOf(node)?.getParent()?.getIndexWithinParent() ?? 0;

/**
 * A selection between two cells of one table reads as the cells of the rectangle they span, tab-separated, one row
 * per line, as Lexical's table selection copies them; null for any other selection.
 */
function $cellsText(from: LexicalNode, to: LexicalNode): string | null {
  const a = cellOf(from);
  const b = cellOf(to);
  const table = a?.getParent()?.getParent();
  if (!a || !b || a === b || !$isElementNode(table) || b.getParent()?.getParent() !== table) return null;
  const [top, bottom] = [rowOf(a), rowOf(b)].sort((x, y) => x - y);
  const [left, right] = [a.getIndexWithinParent(), b.getIndexWithinParent()].sort((x, y) => x - y);
  return table
    .getChildren()
    .slice(top, bottom! + 1)
    .map((row) => ($isElementNode(row) ? row.getChildren().slice(left, right! + 1).map((cell) => cell.getTextContent()).join('\t') : ''))
    .join('\n');
}

const headingLevel = (node: LexicalNode): number => {
  if (node.getType() !== 'heading') return 0;
  const tag = (node as unknown as { getTag(): string }).getTag();
  return Number(tag.slice(1)) || 0;
};

/**
 * The selection in `editor`'s body, or null when it is collapsed or outside the body. `linesBefore(body)` is the
 * number of lines the note file holds before the body (frontmatter, the title line and the blank after it).
 */
export function readSelection(editor: LexicalEditor, exp: MossExport, linesBefore: (body: string) => number): MossSelection | null {
  const root = editor.getRootElement();
  if (!root) return null;
  const range = bodyRange(root);
  if (!range) return null;
  return editor.read(() => {
    let selected: BodyRange;
    let start: { block: LexicalNode; node: LexicalNode } | null;
    let end: { block: LexicalNode; node: LexicalNode } | null;
    if (range === 'none') {
      // A selection across table cells is Lexical's own; the editable editor hides the page's.
      const table = $getSelection();
      if (!$isTableSelection(table)) return null;
      const at = (node: LexicalNode) => {
        const block = $topLevel(node);
        return block ? { block, node } : null;
      };
      const cells = [table.anchor.getNode(), table.focus.getNode()].sort((a, b) => rowOf(a) - rowOf(b));
      start = at(cells[0]!);
      end = at(cells[1]!);
      selected = { start: { node: root, offset: 0 }, end: { node: root, offset: 0 }, field: null, range: null };
    } else {
      selected = range;
      start = $blockAt(selected.start, 'start');
      end = $blockAt(selected.end, 'end');
    }
    if (!start || !end) return null;
    const children = $getRoot().getChildren();
    const first = children.indexOf(start.block);
    const lastIndex = children.indexOf(end.block);
    if (first < 0 || lastIndex < first) return null;

    const { body, spans } = $layout(children, exp);
    const offset = linesBefore(body) + 1;
    const startSpan = spans[first]!;
    const endSpan = spans[lastIndex]!;
    const startLine = startSpan[0] + ($lineIn(editor, start.block, start.node, selected.start, 'start', startSpan[1] - startSpan[0] + 1) ?? 0);
    const endWithin = $lineIn(editor, end.block, end.node, selected.end, 'end', endSpan[1] - endSpan[0] + 1);
    const endLine = endWithin === null ? endSpan[1] : endSpan[0] + endWithin;

    // The heading path at each block: a heading closes every heading at its level or deeper.
    const path: { level: number; text: string }[] = [];
    let headings: string[] = [];
    const blocks: MossSelection['blocks'] = [];
    for (let i = 0; i <= lastIndex; i += 1) {
      const child = children[i]!;
      const level = headingLevel(child);
      if (level) {
        while (path.length && path[path.length - 1]!.level >= level) path.pop();
        path.push({ level, text: child.getTextContent() });
      }
      if (i === first) headings = path.map((entry) => entry.text);
      if (i < first) continue;
      const heading = path[path.length - 1]?.text;
      blocks.push({ type: child.getType(), line: offset + spans[i]![0], ...(heading === undefined ? {} : { heading }) });
    }

    let text = selected.field ?? $cellsText(start.node, end.node);
    if (text === null) {
      const inOneDecorator = start.block === end.block && $isDecoratorNode(start.block);
      const code = inOneDecorator ? codeOf(start.block) : null;
      const from = code === null ? null : codeOffset(editor, start.block, code, selected.start);
      const to = code === null ? null : codeOffset(editor, start.block, code, selected.end);
      const lexical = inOneDecorator
        ? null
        : $createRangeSelectionFromDom(
            {
              anchorNode: selected.start.node,
              anchorOffset: selected.start.offset,
              focusNode: selected.end.node,
              focusOffset: selected.end.offset,
            } as unknown as Selection,
            editor,
          );
      if (code !== null && from !== null && to !== null) text = code.slice(from, to);
      else text = lexical && !lexical.isCollapsed() ? lexical.getTextContent() : (selected.range?.toString() ?? '');
    }

    const markdown = exp.stripMarkers(body.split('\n').slice(startLine, endLine + 1).join('\n'));
    return {
      text: exp.stripMarkers(text),
      markdown,
      lines: { start: offset + startLine, end: offset + endLine },
      headings,
      blocks,
    };
  });
}

/** Lines before `body` in `file`, or null when the file does not end with it. */
export function linesBeforeBody(file: string, body: string): number | null {
  if (!file.endsWith(body)) return null;
  const prefix = file.slice(0, file.length - body.length);
  return prefix.split('\n').length - 1;
}
