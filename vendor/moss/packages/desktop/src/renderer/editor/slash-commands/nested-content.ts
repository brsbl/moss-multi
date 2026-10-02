// ported-from: packages/desktop/src/renderer/editor/slash-commands/nested-content.ts @ 762abb777
import {
  $getSelection,
  $isRangeSelection,
  type LexicalEditor
} from 'lexical';
import {
  filterNestedContentItems,
  getNestedContentOptionsFromNode,
  isNestedContentItemAllowed,
  type NestedContentContext
} from '../utils/nested-editable-block';
import { CalloutNode, $isCalloutNode } from '../nodes/CalloutNode';
import { TabGroupNode } from '../nodes/TabGroupNode';
import { $isTabPanelNode } from '../nodes/TabPanelNode';
import type { SlashCommand } from './types';

const SLASH_COMMAND_NESTED_CONTENT_CONTEXTS: readonly NestedContentContext[] = [
  {
    matches: $isCalloutNode,
    excludedDependencies: [CalloutNode]
  },
  {
    matches: $isTabPanelNode,
    excludedDependencies: [TabGroupNode]
  }
];

export function $filterSlashCommandsForNestedContent(
  commands: readonly SlashCommand[]
): SlashCommand[] {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return [...commands];
  }

  const options = getNestedContentOptionsFromNode(
    selection.anchor.getNode(),
    SLASH_COMMAND_NESTED_CONTENT_CONTEXTS
  );
  return filterNestedContentItems(commands, options);
}

export function canRunSlashCommandAtSelection(
  editor: LexicalEditor,
  dependencies: readonly unknown[] | undefined
): boolean {
  let canRun = true;
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return;
    }

    const options = getNestedContentOptionsFromNode(
      selection.anchor.getNode(),
      SLASH_COMMAND_NESTED_CONTENT_CONTEXTS
    );
    canRun = isNestedContentItemAllowed({ dependencies }, options);
  });
  return canRun;
}

export function runSlashCommandWhenAllowed(
  editor: LexicalEditor,
  dependencies: readonly unknown[] | undefined,
  run: () => void
): void {
  if (!canRunSlashCommandAtSelection(editor, dependencies)) {
    return;
  }
  run();
}
