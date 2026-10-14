import { describe, expect, it } from 'vitest';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  createEditor,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import { $holdInsertionPoint, type HeldInsertionPoint, settleHeldInsertions, shiftOffset } from './held-insertion.ts';

describe('shiftOffset', () => {
  it('moves the point past text inserted before it and keeps it for text after it', () => {
    expect(shiftOffset('abcdef', '123abcdef', 1)).toBe(4);
    expect(shiftOffset('abcdef', 'abcdef!', 1)).toBe(1);
    expect(shiftOffset('abcdef', 'bcdef', 3)).toBe(2);
    expect(shiftOffset('abcdef', 'abXef', 3)).toBe(3);
  });
});

/** A one-paragraph editor holding `text`, with every update applied synchronously. */
function editorWith(text: string) {
  const editor = createEditor({ onError: (error) => { throw error; } });
  let key = '';
  editor.update(() => {
    const node = $createTextNode(text);
    key = node.getKey();
    $getRoot().append($createParagraphNode().append(node));
  }, { discrete: true });
  const edit = (change: (node: TextNode) => void) => editor.update(() => {
    const node = $getRoot().getAllTextNodes().find((candidate) => candidate.getKey() === key);
    if ($isTextNode(node)) change(node);
  }, { discrete: true });
  const content = () => editor.getEditorState().read(() => $getRoot().getTextContent());
  return { editor, edit, content };
}

/** Selects `from`..`to` of the first line and holds it, as a paste handler does. */
function holdIn(editor: LexicalEditor, from: number, to: number): HeldInsertionPoint | null {
  let held = null as HeldInsertionPoint | null;
  editor.update(() => {
    $getRoot().getAllTextNodes()[0].select(from, to);
    held = $holdInsertionPoint();
  }, { discrete: true });
  return held;
}

/** The upload succeeded: the media lands where the hold says. */
function land(editor: LexicalEditor, held: HeldInsertionPoint | null) {
  editor.update(() => {
    expect(held?.$restore()).toBe(true);
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.insertText('[img]');
  }, { discrete: true });
}

describe('a held insertion point (A§16; A§0 invariant 2)', () => {
  it("keeps the pasted-over text until the media lands, then replaces only it, after a peer's and the user's edits", () => {
    const { editor, edit, content } = editorWith('abcdef');
    const held = holdIn(editor, 1, 3);
    expect(content(), 'the selected "bc" stays while the upload is held').toBe('abcdef');
    // While the upload is held, a peer types at the line's start and the user types at its end.
    edit((node) => node.spliceText(0, 0, '123'));
    edit((node) => node.spliceText(node.getTextContentSize(), 0, '!'));
    expect(content()).toBe('123abcdef!');
    land(editor, held);
    expect(content(), "the media replaces exactly the held range, and nobody's text is deleted").toBe('123a[img]def!');
  });

  it('a refused upload (B170: 413, 415) leaves the selected text and a peer edit in place, with no media', () => {
    const { editor, edit, content } = editorWith('abcdef');
    const held = holdIn(editor, 1, 3);
    edit((node) => node.spliceText(0, 0, '123'));
    held?.release();
    expect(content(), 'release touches nothing').toBe('123abcdef');
    edit((node) => node.spliceText(node.getTextContentSize(), 0, '!'));
    expect(content()).toBe('123abcdef!');
  });

  it("follows a peer's edit inside the held range, and replaces the range as it now stands", () => {
    const { editor, edit, content } = editorWith('abcdef');
    const held = holdIn(editor, 1, 4);
    edit((node) => node.spliceText(0, 0, '>'));
    edit((node) => node.spliceText(3, 0, 'XY'));
    expect(content()).toBe('>abXYcdef');
    land(editor, held);
    expect(content()).toBe('>a[img]ef');
  });

  it('a backward selection across two lines lands between the same characters', () => {
    const { editor, content } = editorWith('abc');
    let held = null as HeldInsertionPoint | null;
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('xyz')));
      const [first, second] = $getRoot().getAllTextNodes();
      const range = $createRangeSelection();
      range.anchor.set(second.getKey(), 1, 'text');
      range.focus.set(first.getKey(), 2, 'text');
      $setSelection(range);
      held = $holdInsertionPoint();
    }, { discrete: true });
    expect(content()).toBe('abc\n\nxyz');
    land(editor, held);
    expect(content()).toBe('ab[img]yz');
  });

  it('lands at the end of the document when its line was deleted meanwhile', () => {
    const { editor, edit, content } = editorWith('abc');
    let held = null as HeldInsertionPoint | null;
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('tail')));
      $getRoot().getAllTextNodes()[0].select(1, 1);
      held = $holdInsertionPoint();
    }, { discrete: true });
    edit((node) => node.getParentOrThrow().remove());
    land(editor, held);
    expect(content()).toBe('tail[img]');
  });

  it('with a block selected (a clicked image), holds the point after it and removes nothing (B188)', () => {
    const { editor, content } = editorWith('abc');
    let held = null as HeldInsertionPoint | null;
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('tail')));
      const selection = $createNodeSelection();
      selection.add($getRoot().getFirstChildOrThrow().getKey());
      $setSelection(selection);
      held = $holdInsertionPoint();
    }, { discrete: true });
    expect(held, 'a node selection is a place to insert').not.toBeNull();
    editor.update(() => {
      expect(held?.$restore()).toBe(true);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertNodes([$createParagraphNode().append($createTextNode('[img]'))]);
    }, { discrete: true });
    expect(content()).toBe('abc\n\n[img]\n\ntail');
  });

  it('settleHeldInsertions waits for every held insertion to land or be released, its update committed (B189)', async () => {
    const { editor, content } = editorWith('abcdef');
    const first = holdIn(editor, 1, 3);
    const second = holdIn(editor, 4, 5);
    let settled = false;
    const settling = settleHeldInsertions(editor).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled, 'two insertions are held').toBe(false);
    second?.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled, 'one insertion is still held').toBe(false);
    editor.update(() => {
      first?.$restore();
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText('[img]');
    });
    await settling;
    expect(content(), 'the landed media is committed when the settle resolves').toBe('a[img]def');
  });
});
