// ported-from: packages/desktop/src/renderer/editor/AutoArrowPlugin.tsx @ 762abb777
import { useEffect } from 'react';

import { CodeNode } from '@lexical/code';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, TextNode } from 'lexical';

const RIGHT_ARROW = '\u2192';
const LEFT_ARROW = '\u2190';
const EM_DASH = '\u2014';

const ARROW_PATTERNS: Array<{ match: string; replacement: string }> = [
  { match: '->', replacement: RIGHT_ARROW },
  { match: '<-', replacement: LEFT_ARROW }
];

/**
 * Patterns that require lookahead-style checks (e.g. `--` must not be part of `---`).
 * Processed separately to avoid false positives with horizontal rules.
 */
const DASH_PATTERNS: Array<{ match: string; replacement: string }> = [
  { match: '--', replacement: EM_DASH }
];

/**
 * Calculate the new cursor offset after arrow replacement.
 * Adjusts for the difference in length between the original pattern (2 chars)
 * and the replacement arrow (1 char).
 */
function calculateAdjustedOffset(
  originalContent: string,
  newContent: string,
  originalOffset: number
): number {
  // Find all replacements that happened before the cursor position
  let offset = originalOffset;

  // Arrow patterns: simple indexOf scan (2 chars → 1 char each)
  for (const { match } of ARROW_PATTERNS) {
    let searchIndex = 0;
    let matchIndex = originalContent.indexOf(match, searchIndex);
    while (matchIndex !== -1 && matchIndex < originalOffset) {
      offset -= 1;
      searchIndex = matchIndex + match.length;
      matchIndex = originalContent.indexOf(match, searchIndex);
    }
  }

  // Dash patterns: use regex to match `--` not part of `---` (same as replacement logic)
  for (const m of originalContent.matchAll(/(?<!-)-{2}(?!-)/g)) {
    if (m.index !== undefined && m.index < originalOffset) {
      offset -= 1;
    }
  }

  // Clamp to valid range
  return Math.max(0, Math.min(offset, newContent.length));
}

export function AutoArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (textNode) => {
      const parent = textNode.getParent();
      if (parent instanceof CodeNode) {
        return;
      }

      // Skip inline code spans
      if (textNode.hasFormat('code')) {
        return;
      }

      const textContent = textNode.getTextContent();

      const hasArrow = textContent.includes('->') || textContent.includes('<-');
      const hasDash = textContent.includes('--');
      if (!hasArrow && !hasDash) {
        return;
      }

      let updatedContent = textContent;

      // Arrow replacements (unconditional)
      for (const { match, replacement } of ARROW_PATTERNS) {
        if (updatedContent.includes(match)) {
          updatedContent = updatedContent.replace(new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacement);
        }
      }

      // Em-dash: replace `--` only when NOT part of `---` (horizontal rule marker)
      for (const { match, replacement } of DASH_PATTERNS) {
        if (updatedContent.includes(match)) {
          // Replace `--` that is not preceded or followed by another `-`
          updatedContent = updatedContent.replace(/(?<!-)-{2}(?!-)/g, replacement);
        }
      }

      if (updatedContent !== textContent) {
        // Capture current selection before modifying content
        const selection = $getSelection();
        let anchorOffset: number | null = null;
        let focusOffset: number | null = null;
        const nodeKey = textNode.getKey();

        if ($isRangeSelection(selection)) {
          if (selection.anchor.key === nodeKey) {
            anchorOffset = selection.anchor.offset;
          }
          if (selection.focus.key === nodeKey) {
            focusOffset = selection.focus.offset;
          }
        }

        // Update the content
        textNode.setTextContent(updatedContent);

        // Restore selection with adjusted offsets
        if ($isRangeSelection(selection) && (anchorOffset !== null || focusOffset !== null)) {
          if (anchorOffset !== null) {
            const newAnchorOffset = calculateAdjustedOffset(textContent, updatedContent, anchorOffset);
            selection.anchor.set(nodeKey, newAnchorOffset, 'text');
          }
          if (focusOffset !== null) {
            const newFocusOffset = calculateAdjustedOffset(textContent, updatedContent, focusOffset);
            selection.focus.set(nodeKey, newFocusOffset, 'text');
          }
        }
      }
    });
  }, [editor]);

  return null;
}

export default AutoArrowPlugin;
