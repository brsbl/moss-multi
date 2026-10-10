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

/**
 * The selection clamped to the editor root; null when it is outside it or collapsed in a code block's textarea,
 * 'caret' when it is collapsed in the body, 'none' when the page has none.
 */
function bodyRange(root: HTMLElement): BodyRange | null | 'none' | 'caret' {
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  if (active instanceof HTMLTextAreaElement && root.contains(active)) {
    const { selectionStart: from, selectionEnd: to, value } = active;
    if (from === to) return null;
    return { start: { node: active, offset: from }, end: { node: active, offset: to }, field: value.slice(from, to), range: null };
  }
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0) return 'none';
  if (selection.isCollapsed) return selection.anchorNode && root.contains(selection.anchorNode) ? 'caret' : null;
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

/** A code block being edited: its textarea holds code the node gets only on blur, which a save would then write. */
interface Draft {
  key: string;
  code: string;
}

/** A code block's source, the draft's when it is the one being edited; moss's CodeBlockNode is a decorator with getCode(). */
function codeOf(block: LexicalNode, draft: Draft | null = null): string | null {
  const getCode = $isDecoratorNode(block) ? (block as { getCode?: () => string }).getCode : undefined;
  if (typeof getCode !== 'function') return null;
  return draft && draft.key === block.getKey() ? draft.code : getCode.call(block);
}

/**
 * The index of a code block's opening fence among its exported lines, with `code` right after it and the closing
 * fence after that (a block comment adds a marker line around them); null when the export is not that.
 */
function fenceIn(chunk: string, code: string): number | null {
  const lines = chunk.split('\n');
  const count = code.split('\n').length;
  for (let fence = 0; fence + count + 1 < lines.length; fence += 1) {
    if (!lines[fence]!.startsWith('```')) continue;
    if (lines.slice(fence + 1, fence + 1 + count).join('\n') === code && lines[fence + 1 + count]!.startsWith('```')) return fence;
  }
  return null;
}

/** The body as a save writes it, each root child's export, and its first and last line in the body (0-based). */
function $layout(children: LexicalNode[], exp: MossExport, draft: Draft | null): { body: string; chunks: string[]; spans: [number, number][] } {
  let body = exp.finish($convertToMarkdownString(exp.transformers));
  // The exporter reads only the parent's children, so one block exports exactly as it does inside the body.
  const chunks = children.map((child) => exp.finish($convertToMarkdownString(exp.transformers, { getChildren: () => [child] } as unknown as ElementNode)));
  if (draft) {
    // Write the draft into the export, as the blur that commits it would.
    let cursor = 0;
    for (const [i, child] of children.entries()) {
      const chunk = chunks[i]!;
      const at = chunk ? body.indexOf(chunk, cursor) : -1;
      if (at < 0) continue;
      if (child.getKey() === draft.key) {
        const code = codeOf(child);
        const fence = code === null ? null : fenceIn(chunk, code);
        if (code !== null && fence !== null) {
          const lines = chunk.split('\n');
          const next = [...lines.slice(0, fence + 1), draft.code, ...lines.slice(fence + 1 + code.split('\n').length)].join('\n');
          body = body.slice(0, at) + next + body.slice(at + chunk.length);
          chunks[i] = next;
        }
        break;
      }
      cursor = at + chunk.length;
    }
  }
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
  const spans = chunks.map((chunk): [number, number] => {
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
  return { body, chunks, spans };
}

const isWrapperItem = (node: LexicalNode) =>
  $isElementNode(node) && node.getChildrenSize() > 0 && node.getChildren().every((child) => child.getType() === 'list');

function $ancestorOfType(node: LexicalNode, block: LexicalNode, test: (node: LexicalNode) => boolean): LexicalNode | null {
  for (let current: LexicalNode | null = node; current && current !== block.getParent(); current = current.getParent()) {
    if (test(current)) return current;
  }
  return null;
}

/** The line, within a block's exported lines (`chunk`), that a point sits on; null when only the whole block can be named. */
function $lineIn(
  editor: LexicalEditor,
  block: LexicalNode,
  node: LexicalNode,
  point: Point,
  side: 'start' | 'end',
  chunk: string,
  count: number,
  draft: Draft | null,
): number | null {
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
  const code = codeOf(block, draft);
  const fence = code === null || chunk.split('\n').length !== count ? null : fenceIn(chunk, code);
  if (code !== null && fence !== null) {
    const offset = codeOffset(editor, block, code, point);
    if (offset === null) return null;
    // A selection ending at a line's start ends on the line before it.
    const upTo = side === 'end' && offset > 0 && code[offset - 1] === '\n' ? offset - 1 : offset;
    return fence + code.slice(0, upTo).split('\n').length;
  }
  return null;
}

/**
 * A point's offset in a code block's source: in its open textarea, or in the highlighted lines moss renders
 * (one `.moss-codeblock-line` per source line, without the newlines). Null when the point is not in the source.
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

/** Rows of a table, cells tab-separated, one row per line, as Lexical's table selection copies them. */
function rowsText(table: ElementNode, top: number, bottom: number, left = 0, right = Infinity): string {
  return table
    .getChildren()
    .slice(top, bottom + 1)
    .map((row) => ($isElementNode(row) ? row.getChildren().slice(left, right + 1).map((cell) => cell.getTextContent()).join('\t') : ''))
    .join('\n');
}

/** A selection between two cells of one table reads as the rectangle of cells they span; null for any other selection. */
function $cellsText(from: LexicalNode, to: LexicalNode): string | null {
  const a = cellOf(from);
  const b = cellOf(to);
  const table = a?.getParent()?.getParent();
  if (!a || !b || a === b || !$isElementNode(table) || b.getParent()?.getParent() !== table) return null;
  const [top, bottom] = [rowOf(a), rowOf(b)].sort((x, y) => x - y);
  const [left, right] = [a.getIndexWithinParent(), b.getIndexWithinParent()].sort((x, y) => x - y);
  return rowsText(table, top!, bottom!, left, right);
}

interface End {
  point: Point;
  node: LexicalNode;
}

/**
 * The plain text a selection covers in one top-level block, from `from` (else the block's start) to `to` (else its
 * end): a code block's source, never its header or gutter; whole table rows; Lexical's own text for anything else.
 */
function $blockText(editor: LexicalEditor, block: LexicalNode, from: End | null, to: End | null, draft: Draft | null): string {
  const code = codeOf(block, draft);
  if (code !== null) {
    const start = from ? (codeOffset(editor, block, code, from.point) ?? 0) : 0;
    const end = to ? (codeOffset(editor, block, code, to.point) ?? code.length) : code.length;
    return code.slice(start, Math.max(start, end));
  }
  if (block.getType() === 'table' && $isElementNode(block) && (!from || !to || cellOf(from.node) !== cellOf(to.node))) {
    const cells = from && to ? $cellsText(from.node, to.node) : null;
    if (cells !== null) return cells;
    return rowsText(block, from ? rowOf(from.node) : 0, to ? rowOf(to.node) : block.getChildrenSize() - 1);
  }
  if (!$isElementNode(block)) return block.getTextContent();
  const element = editor.getElementByKey(block.getKey());
  if (!element) return '';
  const start = from?.point ?? { node: element, offset: 0 };
  const end = to?.point ?? { node: element, offset: element.childNodes.length };
  const lexical = $createRangeSelectionFromDom(
    { anchorNode: start.node, anchorOffset: start.offset, focusNode: end.node, focusOffset: end.offset } as unknown as Selection,
    editor,
  );
  if (lexical) return lexical.isCollapsed() ? '' : lexical.getTextContent();
  const range = element.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range.toString();
}

const headingLevel = (node: LexicalNode): number => {
  if (node.getType() !== 'heading') return 0;
  const tag = (node as unknown as { getTag(): string }).getTag();
  return Number(tag.slice(1)) || 0;
};

/** Maps a 0-based line of the exported body to its 1-based line in the note file, as a range's start or end. */
export type PlaceLine = (line: number, side: 'start' | 'end') => number;

/** The code block whose textarea has focus, when it holds code its node does not have yet. */
function $draftOf(root: HTMLElement): Draft | null {
  const active = root.ownerDocument.activeElement;
  if (!(active instanceof HTMLTextAreaElement) || !root.contains(active)) return null;
  const node = $getNearestNodeFromDOMNode(active);
  const block = node ? $topLevel(node) : null;
  const code = block ? codeOf(block) : null;
  return block && code !== null && code !== active.value ? { key: block.getKey(), code: active.value } : null;
}

/**
 * The selection in `editor`'s body, or null when it is collapsed or outside the body. `place(body)` maps the
 * exported body's lines to the note file's, which holds frontmatter, the title line and a blank line before the body.
 */
export function readSelection(editor: LexicalEditor, exp: MossExport, place: (body: string) => PlaceLine): MossSelection | null {
  const root = editor.getRootElement();
  if (!root) return null;
  const range = bodyRange(root);
  if (!range) return null;
  return editor.read(() => {
    let selected: BodyRange;
    let start: { block: LexicalNode; node: LexicalNode } | null;
    let end: { block: LexicalNode; node: LexicalNode } | null;
    let cells: string | null = null;
    if (range === 'none' || range === 'caret') {
      // A selection across table cells is Lexical's own; the editable editor leaves the page only a caret.
      const table = $getSelection();
      if (!$isTableSelection(table)) return null;
      const at = (node: LexicalNode) => {
        const block = $topLevel(node);
        return block ? { block, node } : null;
      };
      const ends = [table.anchor.getNode(), table.focus.getNode()].sort((a, b) => rowOf(a) - rowOf(b));
      start = at(ends[0]!);
      end = at(ends[1]!);
      cells = $cellsText(ends[0]!, ends[1]!);
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

    const draft = $draftOf(root);
    const { body, chunks, spans } = $layout(children, exp, draft);
    const toFile = place(body);
    const startSpan = spans[first]!;
    const endSpan = spans[lastIndex]!;
    const startWithin = $lineIn(editor, start.block, start.node, selected.start, 'start', chunks[first]!, startSpan[1] - startSpan[0] + 1, draft);
    const endWithin = $lineIn(editor, end.block, end.node, selected.end, 'end', chunks[lastIndex]!, endSpan[1] - endSpan[0] + 1, draft);
    const startLine = startSpan[0] + (startWithin ?? 0);
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
      blocks.push({ type: child.getType(), line: toFile(spans[i]![0], 'start'), ...(heading === undefined ? {} : { heading }) });
    }

    let text = selected.field ?? cells;
    if (text === null) {
      const parts: string[] = [];
      for (let i = first; i <= lastIndex; i += 1) {
        const from = i === first ? { point: selected.start, node: start.node } : null;
        const to = i === lastIndex ? { point: selected.end, node: end.node } : null;
        parts.push($blockText(editor, children[i]!, from, to, draft));
      }
      text = parts.join('\n');
    }

    const markdown = exp.stripMarkers(body.split('\n').slice(startLine, endLine + 1).join('\n'));
    return {
      text: exp.stripMarkers(text),
      markdown,
      lines: { start: toFile(startLine, 'start'), end: toFile(endLine, 'end') },
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

/** Lines of a body the file holds as exported, after `before` lines. */
export const offsetLines =
  (before: number): PlaceLine =>
  (line) =>
    before + 1 + line;

/**
 * Lines of an exported body in a file body that may differ from it (a loaded note whose block comment markers the
 * export drops): each exported line goes to the next file line with the same text, markers stripped. A range widens
 * over the marker-only lines next to it, which belong to the block they wrap.
 */
export function alignedLines(exported: string, file: string, before: number, stripMarkers: (markdown: string) => string): PlaceLine {
  const raw = file.split('\n');
  const wanted = raw.map((line) => stripMarkers(line));
  const marker = (index: number) => raw[index] !== undefined && raw[index] !== '' && wanted[index] === '';
  const map: number[] = [];
  let cursor = 0;
  for (const line of exported.split('\n').map((entry) => stripMarkers(entry))) {
    let at = cursor;
    while (at < wanted.length && at < cursor + 8 && wanted[at] !== line) at += 1;
    if (at < wanted.length && wanted[at] === line) {
      map.push(at);
      cursor = at + 1;
    } else {
      map.push(Math.min(cursor, Math.max(raw.length - 1, 0)));
      cursor += 1;
    }
  }
  return (line, side) => {
    let at = map[line] ?? line;
    if (side === 'start') while (at > 0 && marker(at - 1) && (line === 0 || at - 1 > map[line - 1]!)) at -= 1;
    else while (marker(at + 1) && (line + 1 >= map.length || at + 1 < map[line + 1]!)) at += 1;
    return before + 1 + at;
  };
}
