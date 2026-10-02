// ported-from: packages/desktop/src/renderer/editor/ListHotkeyPlugin.tsx @ 762abb777
import { useEffect } from 'react';

import { $isListItemNode } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { LexicalNode } from 'lexical';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  INDENT_CONTENT_COMMAND,
  KEY_DOWN_COMMAND,
  OUTDENT_CONTENT_COMMAND
} from 'lexical';

const LIST_STYLES_ID = 'list-hotkey-plugin-styles';

(() => {
  if (typeof document === 'undefined' || document.getElementById(LIST_STYLES_ID)) {
    return;
  }
  const style = document.createElement('style');
  style.id = LIST_STYLES_ID;
  const scopeSelector = '[data-lexical-editor]';
  style.textContent = `
    /* Hide bullet from list items that only contain a nested list */
    ${scopeSelector} li:has(> ul:only-child)::marker,
    ${scopeSelector} li:has(> ol:only-child)::marker {
      content: none;
    }

    /* Different bullet styles for each nesting level */
    ${scopeSelector} ul > li::marker {
      color: var(--ink-default);
    }
    ${scopeSelector} ul ul > li::marker {
      color: var(--ink-muted);
    }
    ${scopeSelector} ul ul ul > li::marker {
      color: var(--ink-faint);
    }
    ${scopeSelector} ul ul ul ul > li::marker {
      content: '▫ ';
      color: var(--ink-muted);
    }

    /* Circles for second level bullets */
    ${scopeSelector} ul ul > li {
      list-style-type: circle;
    }

    /* Squares for third level bullets */
    ${scopeSelector} ul ul ul > li {
      list-style-type: square;
    }

    /* Hollow squares for fourth level bullets */
    ${scopeSelector} ul ul ul ul > li {
      list-style-type: none;
    }

    /* Subtle color variations for ordered lists */
    ${scopeSelector} ol > li::marker {
      color: var(--ink-default);
      font-weight: 500;
    }
    ${scopeSelector} ol ol > li::marker {
      color: var(--ink-muted);
      font-weight: 400;
    }
    ${scopeSelector} ol ol ol > li::marker {
      color: var(--ink-faint);
      font-weight: 300;
      opacity: 0.7;
    }
    ${scopeSelector} ol ol ol ol > li::marker {
      color: var(--ink-faint);
      font-weight: 300;
      opacity: 0.6;
    }
  `;
  document.head.appendChild(style);
})();


const isListSelection = () => {
  const selection = $getSelection();

  if (!$isRangeSelection(selection)) {
    return null;
  }

  let node: LexicalNode | null = selection.anchor.getNode();
  while (node) {
    if ($isListItemNode(node)) {
      return selection;
    }
    node = node.getParent();
  }

  return null;
};

export function ListHotkeyPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (!event) {
          return false;
        }

        const isModifierPressed = event.metaKey || event.ctrlKey;
        if (!isModifierPressed || event.altKey) {
          return false;
        }

        if (event.key !== '[' && event.key !== ']') {
          return false;
        }

        const shouldHandle = editor.getEditorState().read(() => {
          const selection = isListSelection();
          return selection !== null;
        });

        if (!shouldHandle) {
          return false;
        }

        event.preventDefault();

        const command = event.key === ']' ? INDENT_CONTENT_COMMAND : OUTDENT_CONTENT_COMMAND;
        editor.dispatchCommand(command, undefined);

        return true;
      },
      COMMAND_PRIORITY_CRITICAL
    );
  }, [editor]);

  return null;
}

export default ListHotkeyPlugin;
