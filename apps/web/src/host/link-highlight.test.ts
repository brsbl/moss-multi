// @vitest-environment jsdom
// The link popover's paint (A§10.10): the selected range becomes the `link-selection` CSS highlight, whatever inline
// tags Lexical wraps a text node's characters in (code, highlight, sub and sup text sit inside an outer tag).
import {
  $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, createEditor, type LexicalEditor, type RangeSelection,
  type TextFormatType,
} from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLinkSelection, markLinkSelection } from './link-highlight.ts';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

let frames: FrameRequestCallback[] = [];
let highlights: Map<string, FakeHighlight>;

beforeEach(() => {
  frames = [];
  highlights = new Map();
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal('Highlight', FakeHighlight);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
});

afterEach(() => {
  clearLinkSelection();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** One paragraph: `first` with `format` (so the two never merge), then plain `second`. Returns both text keys. */
function paragraph(first: string, format: TextFormatType, second: string): { editor: LexicalEditor; keys: [string, string] } {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  const editor = createEditor({
    onError: (error) => {
      throw error;
    },
  });
  editor.setRootElement(root);
  const keys: string[] = [];
  editor.update(
    () => {
      const a = $createTextNode(first);
      a.toggleFormat(format);
      const b = $createTextNode(second);
      $getRoot().append($createParagraphNode().append(a, b));
      keys.push(a.getKey(), b.getKey());
    },
    { discrete: true },
  );
  return { editor, keys: keys as [string, string] };
}

/** Marks the selection from `anchor` to `focus` as the popover does, then runs the frame that paints it. */
function mark(editor: LexicalEditor, anchor: [string, number], focus: [string, number]): void {
  editor.update(
    () => {
      const selection: RangeSelection = $createRangeSelection();
      selection.anchor.set(anchor[0], anchor[1], 'text');
      selection.focus.set(focus[0], focus[1], 'text');
      markLinkSelection(editor, selection);
    },
    { discrete: true },
  );
  for (const frame of frames.splice(0)) frame(0);
}

const painted = (): string | null => highlights.get('link-selection')?.ranges.map((range) => range.toString()).join('|') ?? null;

describe('the link popover paint', () => {
  it('paints a selection over text with no outer tag', () => {
    const { editor, keys } = paragraph('alpha ', 'bold', 'bravo');
    mark(editor, [keys[0], 2], [keys[1], 3]);
    expect(painted()).toBe('pha bra');
  });

  it.each(['code', 'highlight', 'subscript', 'superscript'] as const)('paints from inside %s text, which Lexical wraps in an outer tag', (format) => {
    const { editor, keys } = paragraph('wrapped', format, ' plain');
    expect(editor.getElementByKey(keys[0])?.firstChild?.nodeType, `${format} text sits in an inner element`).toBe(Node.ELEMENT_NODE);
    mark(editor, [keys[0], 3], [keys[1], 4]);
    expect(painted()).toBe('pped pla');
  });

  it('paints a backward selection that ends inside code text', () => {
    const { editor, keys } = paragraph('codeword', 'code', ' after');
    mark(editor, [keys[1], 3], [keys[0], 4]);
    expect(painted()).toBe('word af');
  });
});
