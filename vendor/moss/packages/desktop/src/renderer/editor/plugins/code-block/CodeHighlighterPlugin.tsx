// ported-from: packages/desktop/src/renderer/editor/plugins/code-block/CodeHighlighterPlugin.tsx @ 762abb777
/**
 * CodeHighlighterPlugin - Syntax highlighting for code blocks using Prism.js
 *
 * Uses Lexical's built-in registerCodeHighlighting which:
 * - Tokenizes code content using Prism
 * - Wraps tokens in CodeHighlightNode with appropriate CSS classes
 * - Re-highlights on text changes
 *
 * NOTE: Prism.js is set up in prism-setup.ts which is imported at the
 * application entry point (main.tsx) before any @lexical/code imports.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { registerCodeHighlighting } from '@lexical/code';

/**
 * Plugin that enables syntax highlighting in code blocks.
 * Automatically highlights code based on the language set on CodeNode.
 */
export function CodeHighlighterPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Register Lexical's code highlighting
    // Uses the global Prism instance set up in prism-setup.ts
    return registerCodeHighlighting(editor);
  }, [editor]);

  return null;
}

export default CodeHighlighterPlugin;
