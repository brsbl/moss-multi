import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createLexicalComposerContext, LexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { expect, it } from 'vitest';
import { ColorCodeNode } from '@moss-desktop/renderer/editor/nodes/ColorCodeNode';
import { CodeBlockNode } from '@moss-desktop/renderer/editor/nodes/CodeBlockNode';
import { ColorCodeConversionPlugin } from '@moss-desktop/renderer/editor/plugins/ColorCodePlugin';

it.each([false, true])('color conversion at mount respects editable=%s in an unbound viewer', async (editable) => {
  const editor = createEditor({ nodes: [ColorCodeNode, CodeBlockNode], editable, onError: error => { throw error; } });
  const body = document.body.appendChild(document.createElement('div'));
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  editor.setRootElement(body);
  editor.update(() => $getRoot().append($createParagraphNode().append($createTextNode('#ff0000'))), { discrete: true });
  const before = editor.getEditorState().toJSON();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(createElement(LexicalComposerContext.Provider, {
      value: [editor, createLexicalComposerContext(null, {})],
    }, createElement(ColorCodeConversionPlugin))));
    const types = editor.read(() => [...editor.getEditorState()._nodeMap.values()].map(node => node.getType()));
    if (editable) expect(types).toContain('color-code');
    else expect(editor.getEditorState().toJSON()).toEqual(before);
  } finally {
    await act(async () => root.unmount());
    editor.setRootElement(null);
    body.remove(); container.remove();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
  }
});
