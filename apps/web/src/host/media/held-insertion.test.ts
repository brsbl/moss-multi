import { describe, expect, it } from 'vitest';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $isTextNode, createEditor, type TextNode } from 'lexical';
import { $holdInsertionPoint, type HeldInsertionPoint, shiftOffset } from './held-insertion.ts';

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

describe('a held insertion point (A§16; A§0 invariant 2)', () => {
  it("removes the pasted-over text at paste time and lands between the same characters after a peer's and the user's edits", () => {
    const { editor, edit, content } = editorWith('abcdef');
    let held = null as HeldInsertionPoint | null;
    editor.update(() => {
      const node = $getRoot().getAllTextNodes()[0];
      node.select(1, 3);
      held = $holdInsertionPoint();
    }, { discrete: true });
    expect(content(), 'the selected "bc" goes at paste time').toBe('adef');
    // While the upload is held, a peer types at the line's start and the user types at its end.
    edit((node) => node.spliceText(0, 0, '123'));
    edit((node) => node.spliceText(node.getTextContentSize(), 0, '!'));
    expect(content()).toBe('123adef!');
    editor.update(() => {
      expect(held?.$restore()).toBe(true);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText('[img]');
    }, { discrete: true });
    expect(content(), "nobody's text is deleted, and the media lands where it was pasted").toBe('123a[img]def!');
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
    editor.update(() => {
      expect(held?.$restore()).toBe(true);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText('[img]');
    }, { discrete: true });
    expect(content()).toBe('tail[img]');
  });
});
