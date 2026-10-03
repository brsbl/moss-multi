// ported-from: packages/desktop/src/renderer/editor/plugins/FormatWhitespaceBoundaryPlugin.tsx @ 762abb777
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { TextNode } from 'lexical';
import { $normalizeFormatWhitespace } from '../markdown/format-whitespace';

// moss-multi seam: import-formatting (A§12): share the transform with server imports.
export function FormatWhitespaceBoundaryPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerNodeTransform(TextNode, $normalizeFormatWhitespace), [editor]);
  return null;
}
