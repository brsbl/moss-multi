// A bound editor's formula draft chip (local-view, A§10). Moss pads and rounds the draft by splitting its text nodes
// and styling them, which would write to the shared note. Here the chip is local paint: inline padding on the edge
// spans of the draft's DOM, where the draft starts or ends a span, and a rounded box blended under the text.
import type { LexicalEditor } from 'lexical';

const PAD_X = 8; // moss's draft chip: padding 0.5rem a side, 0.125rem above and below, end radius 0.375rem
const PAD_Y = 2;

export interface LineRect { left: number; top: number; width: number; height: number }
export interface ChipBox extends LineRect { roundStart: boolean; roundEnd: boolean }

/** The chip's box on each line the draft covers, padded at its outer ends by at most the room the text leaves. */
export function formulaChipBoxes(lines: LineRect[], { lineHeight, startRoom = PAD_X, endRoom = PAD_X }: { lineHeight: number; startRoom?: number; endRoom?: number }): ChipBox[] {
  const height = lineHeight + 2 * PAD_Y;
  return lines.map((line, index) => {
    const roundStart = index === 0, roundEnd = index === lines.length - 1;
    const before = roundStart ? Math.max(0, Math.min(PAD_X, startRoom)) : 0;
    const after = roundEnd ? Math.max(0, Math.min(PAD_X, endRoom)) : 0;
    return { left: line.left - before, top: line.top + line.height / 2 - height / 2, width: line.width + before + after, height, roundStart, roundEnd };
  });
}

interface ChipState { ranges: Range[]; padded: HTMLElement[]; layer: HTMLDivElement | null; stop: (() => void) | null }
const states = new WeakMap<LexicalEditor, ChipState>();

const textOf = (node: Node): Text | null => (node.nodeType === Node.TEXT_NODE ? (node as Text) : null);

/** The rects of one line each, left to right, top to bottom. */
function lineRects(ranges: Range[]): DOMRect[] {
  const lines: DOMRect[] = [];
  for (const range of ranges) {
    for (const rect of range.getClientRects()) {
      if (!rect.width && !rect.height) continue;
      const line = lines.find(other => rect.top < other.bottom && other.top < rect.bottom);
      if (!line) { lines.push(DOMRect.fromRect(rect)); continue; }
      const left = Math.min(line.left, rect.left), right = Math.max(line.right, rect.right);
      const top = Math.min(line.top, rect.top), bottom = Math.max(line.bottom, rect.bottom);
      line.x = left; line.y = top; line.width = right - left; line.height = bottom - top;
    }
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** Room beside the draft before the neighbouring character's glyph, or a full pad when a span edge was padded. */
function room(range: Range, side: 'start' | 'end', padded: boolean, edge: number): number {
  if (padded) return PAD_X;
  const text = textOf(side === 'start' ? range.startContainer : range.endContainer);
  const offset = side === 'start' ? range.startOffset : range.endOffset;
  if (!text || (side === 'start' ? offset === 0 : offset >= text.length)) return 0;
  const at = side === 'start' ? offset - 1 : offset;
  if (!/\s/.test(text.data[at])) return 0;
  const neighbour = document.createRange();
  neighbour.setStart(text, at);
  neighbour.setEnd(text, at + 1);
  const rect = neighbour.getBoundingClientRect();
  return Math.max(0, (side === 'start' ? edge - rect.left : rect.right - edge) - 1);
}

function draw(editor: LexicalEditor, state: ChipState): void {
  const root = editor.getRootElement();
  if (!root?.parentNode || !state.ranges.length) { state.layer?.replaceChildren(); return; }
  // A positioned sibling of the root, so it paints over the text: MarkdownEditor.css blends it under the glyphs.
  if (!state.layer || state.layer.nextSibling !== root) {
    state.layer?.remove();
    state.layer = document.createElement('div');
    state.layer.className = 'moss-formula-draft-layer';
    state.layer.setAttribute('aria-hidden', 'true');
    root.parentNode.insertBefore(state.layer, root);
  }
  const lines = lineRects(state.ranges);
  const first = state.ranges[0], last = state.ranges[state.ranges.length - 1];
  const span = textOf(first.startContainer)?.parentElement;
  const lineHeight = (span && parseFloat(getComputedStyle(span).lineHeight)) || (lines[0]?.height ?? 0);
  const boxes = lines.length ? formulaChipBoxes(lines, {
    lineHeight,
    startRoom: room(first, 'start', state.padded.includes(span as HTMLElement), lines[0].left),
    endRoom: room(last, 'end', state.padded.includes(textOf(last.endContainer)?.parentElement as HTMLElement), lines[lines.length - 1].right),
  }) : [];
  const origin = state.layer.getBoundingClientRect();
  state.layer.replaceChildren(...boxes.map((box, index) => {
    const element = document.createElement('div');
    element.className = 'moss-formula-draft-chip';
    if (index === 0) element.dataset.formulaDraftChip = '';
    Object.assign(element.style, {
      left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px`, height: `${box.height}px`,
      borderTopLeftRadius: box.roundStart ? '' : '0', borderBottomLeftRadius: box.roundStart ? '' : '0',
      borderTopRightRadius: box.roundEnd ? '' : '0', borderBottomRightRadius: box.roundEnd ? '' : '0',
    });
    return element;
  }));
}

/** Paints the draft over `ranges` for this viewer only; an empty list clears it. */
export function paintFormulaDraft(editor: LexicalEditor, ranges: Range[]): void {
  let state = states.get(editor);
  if (!state) { if (!ranges.length) return; state = { ranges: [], padded: [], layer: null, stop: null }; states.set(editor, state); }
  for (const element of state.padded) { element.style.removeProperty('padding-left'); element.style.removeProperty('padding-right'); }
  state.padded = [];
  state.ranges = ranges;
  if (!ranges.length) {
    state.stop?.(); state.stop = null;
    state.layer?.remove(); state.layer = null;
    return;
  }
  const first = ranges[0], last = ranges[ranges.length - 1];
  const start = textOf(first.startContainer), end = textOf(last.endContainer);
  if (start?.parentElement && first.startOffset === 0) { start.parentElement.style.paddingLeft = `${PAD_X}px`; state.padded.push(start.parentElement); }
  if (end?.parentElement && last.endOffset >= end.length) { end.parentElement.style.paddingRight = `${PAD_X}px`; state.padded.push(end.parentElement); }
  if (!state.stop) {
    const current = state;
    const redraw = () => draw(editor, current);
    const observer = new ResizeObserver(redraw);
    const root = editor.getRootElement();
    if (root) observer.observe(root);
    const unregister = editor.registerUpdateListener(redraw);
    current.stop = () => { observer.disconnect(); unregister(); };
  }
  draw(editor, state);
}
