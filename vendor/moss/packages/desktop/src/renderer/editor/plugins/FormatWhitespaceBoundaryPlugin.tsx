// ported-from: packages/desktop/src/renderer/editor/plugins/FormatWhitespaceBoundaryPlugin.tsx @ 762abb777
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isRootOrShadowRoot, TextNode } from 'lexical';
import { $isCodeNode } from '@lexical/code';

// Matches text that is exactly a markdown block-shortcut prefix followed by a
// single trigger space — e.g. `- `, `* `, `+ `, `1. `, `# ` … `###### `, `> `,
// `[ ] `, `[x] `. Anchored to the whole content so we only fire at the moment
// the trigger space is typed (before any further input).
const MARKDOWN_SHORTCUT_TRIGGER_RE =
  /^\s*(?:[-*+]|\d{1,}\.|#{1,6}|>|\[[ xX]?\]) $/;

/**
 * Strips leading/trailing whitespace from formatted TextNodes by splitting
 * them into adjacent unformatted nodes. This prevents invalid CommonMark
 * like `**hello **` from ever reaching the export pipeline.
 *
 * Modeled after ProseMirror's approach of enforcing formatting boundaries
 * at the document-model level rather than post-processing exported strings.
 *
 * Runs as a node transform — O(1) per dirty node, batched with reconciliation.
 */
export function FormatWhitespaceBoundaryPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregister = editor.registerNodeTransform(TextNode, (node) => {
      // Only formatted nodes need boundary enforcement
      if (node.getFormat() === 0) return;

      // Code content is literal — never strip whitespace
      if (node.hasFormat('code')) return;

      // Skip nodes inside fenced code blocks
      const parent = node.getParent();
      if (parent && $isCodeNode(parent)) return;

      const text = node.getTextContent();
      if (text.length === 0) return;

      // Entirely whitespace with formatting — just clear the format
      // Use [ \t] to avoid matching \u00A0 (Lexical uses it for cursor positioning)
      if (/^[ \t]+$/.test(text)) {
        node.setFormat(0);
        return;
      }

      // When Lexical carries selection format across Enter, typing a markdown
      // block shortcut (`- `, `1. `, `# `, `> `, `[ ] `, ...) on the new line
      // produces a formatted TextNode like bold "- ". The trailing-space split
      // below would leave the prefix formatted and the space unformatted - two
      // siblings - which breaks @lexical/markdown's element-transformer guard
      // `parentNode.getFirstChild() === anchorNode`, suppressing the shortcut.
      // Clearing the format when the node is the sole child of a top-level
      // paragraph and its text is exactly a shortcut prefix lets the shortcut
      // fire on the same keystroke.
      if (
        MARKDOWN_SHORTCUT_TRIGGER_RE.test(text) &&
        parent !== null &&
        parent.getChildrenSize() === 1
      ) {
        const grandparent = parent.getParent();
        if (grandparent !== null && $isRootOrShadowRoot(grandparent)) {
          node.setFormat(0);
          return;
        }
      }

      const leadingMatch = text.match(/^[ \t]+/);
      const trailingMatch = text.match(/[ \t]+$/);

      if (!leadingMatch && !trailingMatch) return;

      const leadingEnd = leadingMatch ? leadingMatch[0].length : 0;
      const trailingStart = trailingMatch
        ? text.length - trailingMatch[0].length
        : text.length;

      // Build split points — single splitText call avoids index shifting
      const splitPoints: number[] = [];
      if (leadingEnd > 0) splitPoints.push(leadingEnd);
      if (trailingStart < text.length && trailingStart > leadingEnd) {
        splitPoints.push(trailingStart);
      }

      if (splitPoints.length === 0) return;

      const parts = node.splitText(...splitPoints);

      // splitText preserves format on all parts — clear it on whitespace nodes
      if (leadingEnd > 0 && parts[0]) {
        parts[0].setFormat(0);
      }
      if (trailingMatch && parts.length > 0) {
        parts[parts.length - 1].setFormat(0);
      }
    });

    return unregister;
  }, [editor]);

  return null;
}
