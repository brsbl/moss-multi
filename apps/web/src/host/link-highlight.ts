// The link popover's selection paint (A§10.10). Moss marks the text under its link popover with a `--link-selection`
// style so it stays visible while the popover holds focus; on a bound note that style is a doc write that syncs to
// peers, persists and takes an undo step. The MarkdownEditor seam paints the same range as the CSS highlight moss's
// stylesheet already styles, `::highlight(link-selection)`, and nothing reaches the doc.
import type { LexicalEditor, PointType, RangeSelection } from 'lexical';

const NAME = 'link-selection';

/** Bumped by every mark and clear, so a paint scheduled before a clear never lands after it. */
let generation = 0;

const supported = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

/** A Lexical point as a DOM position: a text point's span holds one DOM text node. */
function domPoint(editor: LexicalEditor, point: { key: string; offset: number; type: PointType['type'] }): [Node, number] | null {
  const element = editor.getElementByKey(point.key);
  if (!element) return null;
  if (point.type === 'element') return [element, Math.min(point.offset, element.childNodes.length)];
  const text = element.firstChild;
  return text ? [text, Math.min(point.offset, text.textContent?.length ?? 0)] : null;
}

/** Paints `selection` (read inside the update that opens the popover) once that update has reached the DOM. */
export function markLinkSelection(editor: LexicalEditor, selection: RangeSelection): void {
  if (!supported()) return;
  const copy = (point: PointType) => ({ key: point.key, offset: point.offset, type: point.type });
  const backward = selection.isBackward();
  const start = copy(backward ? selection.focus : selection.anchor);
  const end = copy(backward ? selection.anchor : selection.focus);
  const mine = ++generation;
  requestAnimationFrame(() => {
    if (mine !== generation) return;
    const from = domPoint(editor, start);
    const to = domPoint(editor, end);
    if (!from || !to) return;
    const range = document.createRange();
    range.setStart(...from);
    range.setEnd(...to);
    CSS.highlights.set(NAME, new Highlight(range));
  });
}

export function clearLinkSelection(): void {
  generation += 1;
  if (supported()) CSS.highlights.delete(NAME);
}
