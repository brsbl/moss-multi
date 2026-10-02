// ported-from: packages/desktop/src/renderer/editor/utils/heading-selection.ts @ 762abb777
import type { LexicalEditor, LexicalNode } from 'lexical';
import { $getSelection, $isRangeSelection } from 'lexical';
import { $isHeadingNode } from '@lexical/rich-text';
import { stripWikiLinks } from '../../../common/utils';

export const preserveEditorSelectionOnMouseDown = (event: { preventDefault: () => void }): void => {
  event.preventDefault();
};

const getContainingHeadingText = (node: LexicalNode | null): string | null => {
  let current: LexicalNode | null = node;
  while (current) {
    if ($isHeadingNode(current)) {
      const headingText = stripWikiLinks(current.getTextContent()).trim();
      return headingText.length > 0 ? headingText : null;
    }
    current = current.getParent();
  }
  return null;
};

export const getSelectedHeadingTextForCopy = (editor: LexicalEditor): string | null => {
  let selectedHeadingText: string | null = null;

  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return;
    }

    selectedHeadingText =
      getContainingHeadingText(selection.anchor.getNode()) ??
      getContainingHeadingText(selection.focus.getNode());
  });

  return selectedHeadingText;
};
