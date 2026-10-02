// ported-from: packages/desktop/src/renderer/editor/slash-commands/registry.ts @ 762abb777
import {
  $createNodeSelection,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isRangeSelection,
  $createParagraphNode,
  $createTextNode,
  $isElementNode,
  $setSelection,
  IS_BOLD
} from 'lexical';
import { $createHorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
import { $createQuoteNode } from '@lexical/rich-text';
import { $createListNode, $isListItemNode, $isListNode } from '@lexical/list';
import {
  $createTableNode,
  $createTableRowNode,
  $createTableCellNode,
  TableCellHeaderStates
} from '@lexical/table';
import {
  Calculator,
  Calendar,
  Code,
  CodeXml,
  Columns2,
  Flag,
  Minus,
  Palette,
  Quote,
  Smile,
  Table,
  Link2,
  BarChart3,
  LineChart,
  AreaChart,
  Image,
  LineSquiggle,
} from 'lucide-react';
import { CalloutNode, $createCalloutNode } from '../nodes/CalloutNode';
import { $createChartNode } from '../nodes/ChartNode';
import { createSampleChartConfig } from '../utils/chartDefaults';
import { $createImageNode } from '../nodes/ImageNode';
import { $createVideoNode } from '../nodes/VideoNode';
import { $createSketchNode } from '../nodes/SketchNode';
import { $createHtmlBlockquoteNode } from '../nodes/HtmlBlockquoteNode';
import { $createCodeBlockNode, markCodeBlockForAutoEdit } from '../nodes/CodeBlockNode';
import { TabGroupNode, $createTabGroupNode } from '../nodes/TabGroupNode';
import { $createTabPanelNode } from '../nodes/TabPanelNode';
import { imagesApi, systemApi } from '../../api/electron';
import { openMediaSourceDialog } from '../dialogs/useMediaSourceDialog';
import { extractAltFromUrl, preflightRemoteImageUrl } from '../utils/remote-image-url';
import { isLocalVideoPath, isYouTubeUrl } from '../utils/video-url';
import { isRendererDevelopment } from '../../utils/renderer-env';
import {
  createDefaultMossHtmlDocument
} from '../../../common/moss-html-document';
import {
  MOSS_CANVAS_SLASH_ALIASES,
  MOSS_CANVAS_SLASH_COMMAND_ID
} from '../../../common/markdown-fences';
import { OPEN_COLOR_PICKER_COMMAND } from '../plugins/colorPickerCommands';

import type { SlashCommand, SlashCommandCategory } from './types';
import { CATEGORY_ORDER } from './types';
import { runSlashCommandWhenAllowed } from './nested-content';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';

/**
 * Find the ListItemNode containing the given node, if any
 */
function $findContainingListItem(
  node: import('lexical').LexicalNode
): import('@lexical/list').ListItemNode | null {
  let current: import('lexical').LexicalNode | null = node;
  while (current !== null) {
    if ($isListItemNode(current)) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}

function $selectInsertedNode(node: import('lexical').LexicalNode): void {
  if ($isDecoratorNode(node)) {
    const nodeSelection = $createNodeSelection();
    nodeSelection.add(node.getKey());
    $setSelection(nodeSelection);
  } else if ($isElementNode(node)) {
    node.selectEnd();
  }
}

/**
 * Helper to replace the current line/item with a new node.
 * When inside a list, only replaces the current list item, preserving other items.
 */
function replaceCurrentLineWithNode(
  editor: import('lexical').LexicalEditor,
  createNode: () => import('lexical').LexicalNode
) {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    const anchor = selection.anchor;
    const anchorNode = anchor.getNode();

    // Check if we're inside a list item
    const listItem = $findContainingListItem(anchorNode);

    if (listItem) {
      // We're inside a list - need to handle list splitting
      const parentList = listItem.getParent();
      if (!$isListNode(parentList)) return;

      const listItems = parentList.getChildren();
      const itemIndex = listItems.indexOf(listItem);
      const newNode = createNode();

      if (listItems.length === 1) {
        // Only one item in the list - replace the whole list
        parentList.replace(newNode);
      } else if (itemIndex === 0) {
        // First item - insert new node before the list, remove the item
        parentList.insertBefore(newNode);
        listItem.remove();
      } else if (itemIndex === listItems.length - 1) {
        // Last item - insert new node after the list, remove the item
        parentList.insertAfter(newNode);
        listItem.remove();
      } else {
        // Middle item - need to split the list
        // Create a new list for items after the current one
        const listType = parentList.getListType();
        const newList = $createListNode(listType);

        // Move items after current to the new list
        for (let i = itemIndex + 1; i < listItems.length; i++) {
          const item = listItems[i];
          if ($isElementNode(item)) {
            newList.append(item);
          }
        }

        // Insert new node after original list
        parentList.insertAfter(newNode);

        // Insert the new list after the new node
        newNode.insertAfter(newList);

        // Remove the current list item from original list
        listItem.remove();
      }

      $selectInsertedNode(newNode);
    } else {
      // Not in a list - use simple top-level replacement
      const topLevelElement = anchorNode.getTopLevelElement();
      if (!topLevelElement) return;

      const newNode = createNode();
      topLevelElement.replace(newNode);

      $selectInsertedNode(newNode);
    }
  });
}

/**
 * Insert formatted date text at current selection
 */
function insertDateText(
  editor: import('lexical').LexicalEditor,
  formatter: () => string
) {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    const textNode = $createTextNode(formatter());
    selection.insertNodes([textNode]);
  });
}

const CALLOUT_COMMAND_DEPENDENCIES = [CalloutNode] as const;
const TABS_COMMAND_DEPENDENCIES = [TabGroupNode] as const;

type TableCellHeaderState = (typeof TableCellHeaderStates)[keyof typeof TableCellHeaderStates];

const $createBlockTableCell = (
  headerState: TableCellHeaderState,
  textContent = '',
  isBold = false
) => {
  const cell = $createTableCellNode(headerState);
  const paragraph = $createParagraphNode();
  if (isBold) {
    paragraph.setTextFormat(IS_BOLD);
  }
  const text = $createTextNode(textContent);
  if (isBold) {
    text.toggleFormat('bold');
  }
  paragraph.append(text);
  cell.append(paragraph);
  return cell;
};

/**
 * Default slash commands available in the editor
 */
export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  // ── Blocks ──
  {
    id: 'table',
    label: 'Table',
    description: 'Insert a table',
    icon: Table,
    keywords: ['grid', 'spreadsheet', 'columns', 'rows'],
    category: 'blocks',
    execute: (editor) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        const topLevelElement = anchorNode.getTopLevelElement();

        if (!topLevelElement) return;

        // Create a 3x3 table with header row
        const table = $createTableNode();

        // Header row
        const headerRow = $createTableRowNode();
        for (let i = 0; i < 3; i++) {
          headerRow.append($createBlockTableCell(TableCellHeaderStates.ROW, i === 0 ? 'Header' : '', true));
        }
        table.append(headerRow);

        // Data rows
        for (let row = 0; row < 2; row++) {
          const tableRow = $createTableRowNode();
          for (let col = 0; col < 3; col++) {
            tableRow.append($createBlockTableCell(TableCellHeaderStates.NO_STATUS));
          }
          table.append(tableRow);
        }

        topLevelElement.replace(table);
        table.selectEnd();
      });
    }
  },
  {
    id: 'quote',
    label: 'Quote',
    description: 'Insert a blockquote',
    icon: Quote,
    keywords: ['quote', 'blockquote', 'pullquote'],
    category: 'blocks',
    execute: (editor) => {
      replaceCurrentLineWithNode(editor, () => $createQuoteNode());
    }
  },
  {
    id: 'callout',
    label: 'Callout',
    description: 'Insert a callout block',
    icon: Flag,
    keywords: ['callout', 'warning', 'info', 'priority', 'alert', 'notice'],
    dependencies: CALLOUT_COMMAND_DEPENDENCIES,
    category: 'blocks',
    execute: (editor) => {
      runSlashCommandWhenAllowed(editor, CALLOUT_COMMAND_DEPENDENCIES, () => {
        replaceCurrentLineWithNode(editor, () => {
          return $createCalloutNode('info', '');
        });
      });
    }
  },
  {
    id: 'code-block',
    label: 'Code',
    description: 'Add a code block',
    icon: Code,
    keywords: ['code', 'snippet', 'programming', 'syntax'],
    category: 'blocks',
    execute: (editor) => {
      replaceCurrentLineWithNode(editor, () => {
        const node = $createCodeBlockNode('', 'javascript');
        markCodeBlockForAutoEdit(node.getKey());
        return node;
      });
    }
  },
  {
    id: 'html-block',
    label: 'HTML',
    description: 'Insert an HTML block',
    icon: CodeXml,
    keywords: ['html', 'blockquote', 'raw', 'preview'],
    category: 'blocks',
    execute: (editor) => {
      replaceCurrentLineWithNode(editor, () => {
        return $createHtmlBlockquoteNode(createDefaultMossHtmlDocument(), 'fenced');
      });
    }
  },
  {
    id: 'divider',
    label: 'Divider',
    description: 'Insert a horizontal rule',
    icon: Minus,
    keywords: ['divider', 'horizontal', 'rule', 'separator', 'hr', 'line'],
    category: 'blocks',
    execute: (editor) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchorNode = selection.anchor.getNode();
        const topLevelElement = anchorNode.getTopLevelElement();
        if (!topLevelElement) return;

        const hrNode = $createHorizontalRuleNode();
        const paragraph = $createParagraphNode();

        topLevelElement.replace(hrNode);
        hrNode.insertAfter(paragraph);
        paragraph.selectEnd();
      });
    }
  },
  {
    id: 'tabs',
    label: 'Tabs',
    description: 'Insert tabbed content',
    icon: Columns2,
    keywords: ['tabs', 'tab', 'tabbed', 'variants', 'options', 'alternatives'],
    dependencies: TABS_COMMAND_DEPENDENCIES,
    category: 'blocks',
    execute: (editor) => {
      runSlashCommandWhenAllowed(editor, TABS_COMMAND_DEPENDENCIES, () => {
        replaceCurrentLineWithNode(editor, () => {
          const panel1 = $createTabPanelNode('Tab 1');
          panel1.append($createParagraphNode());
          const panel2 = $createTabPanelNode('Tab 2');
          panel2.append($createParagraphNode());
          const group = $createTabGroupNode();
          group.append(panel1, panel2);
          return group;
        });
      });
    }
  },
  // ── Inline ──
  {
    id: 'link',
    label: 'Wiki Link',
    description: 'Insert link to a note',
    icon: Link2,
    keywords: ['link', 'wiki', 'reference', 'internal', 'note'],
    category: 'inline',
    execute: (editor) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        // Insert [[ only - user types the note title and closes with ]]
        // The ]] triggers the FILE_LINK_TRANSFORMER to create the FileLinkNode
        const textNode = $createTextNode('[[');
        selection.insertNodes([textNode]);

        // Position cursor after [[
        textNode.selectEnd();
      });
    }
  },
  {
    id: 'date',
    label: 'Date',
    description: 'Insert current date',
    icon: Calendar,
    keywords: ['date', 'today', 'timestamp'],
    category: 'inline',
    execute: (editor) => {
      insertDateText(editor, () =>
        new Date().toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
      );
    }
  },
  {
    id: 'day',
    label: 'Day',
    description: 'Insert current day of week',
    icon: Calendar,
    keywords: ['day', 'weekday', 'today'],
    category: 'inline',
    execute: (editor) => {
      insertDateText(editor, () =>
        new Date().toLocaleDateString(undefined, { weekday: 'long' })
      );
    }
  },
  {
    id: 'month',
    label: 'Month',
    description: 'Insert current month',
    icon: Calendar,
    keywords: ['month', 'calendar'],
    category: 'inline',
    execute: (editor) => {
      insertDateText(editor, () =>
        new Date().toLocaleDateString(undefined, { month: 'long' })
      );
    }
  },
  {
    id: 'formula',
    label: 'Formula',
    description: 'Start a calculation or named value',
    icon: Calculator,
    keywords: ['formula', 'variable', 'value', 'calculate', 'math', 'equation'],
    category: 'inline',
    execute: (editor) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const textNode = $createTextNode('=');
        selection.insertNodes([textNode]);
        textNode.selectEnd();
      });
    }
  },
  {
    id: 'color-picker',
    label: 'Color Picker',
    description: 'Insert an inline color pill',
    icon: Palette,
    keywords: ['color', 'picker', 'hex', 'rgba', 'hsla', 'swatch'],
    category: 'inline',
    execute: (editor) => {
      editor.dispatchCommand(OPEN_COLOR_PICKER_COMMAND, {
        initialFormat: 'hex',
        seed: null,
        replaceRange: null,
        anchorRect: null
      });
    }
  },
  {
    id: 'emoji',
    label: 'Emoji',
    description: 'Insert an emoji',
    icon: Smile,
    keywords: ['emoji', 'emoticon', 'smiley', 'face'],
    category: 'inline',
    execute: () => {
      systemApi.showEmojiPanel.invoke();
    }
  },
  // ── Media ──
  {
    id: 'media',
    label: 'Media',
    description: 'Insert an image or video',
    icon: Image,
    keywords: ['image', 'picture', 'photo', 'video', 'youtube', 'media', 'upload', 'url'],
    category: 'media',
    execute: async (editor, context) => {
      try {
        // Open the source selection dialog
        const dialogResult = await openMediaSourceDialog();
        if (!dialogResult) return; // User cancelled

        if (dialogResult.type === 'file') {
          // User chose to pick from computer
          const pickerResults = await imagesApi.pick.invoke({ noteId: context?.noteId });
          const validResults = pickerResults.filter(r => r.absolutePath && r.filename);
          if (validResults.length === 0) return; // User cancelled picker

          editor.update(() => {
            const mediaNodes = validResults.map((result) =>
              isLocalVideoPath(result.relativePath)
                ? $createVideoNode(result.relativePath, result.filename)
                : $createImageNode(result.relativePath, result.filename)
            );
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertNodes(mediaNodes);
            } else {
              const root = $getRoot();
              for (const node of mediaNodes) {
                root.append(node);
              }
            }
          });
        } else {
          // User provided a URL
          if (isYouTubeUrl(dialogResult.url)) {
            editor.update(() => {
              const videoNode = $createVideoNode(
                dialogResult.url,
                extractAltFromUrl(dialogResult.url)
              );
              const selection = $getSelection();
              if ($isRangeSelection(selection)) {
                selection.insertNodes([videoNode]);
              } else {
                const root = $getRoot();
                root.append(videoNode);
              }
            });
            return;
          }

          const persisted = await preflightRemoteImageUrl({
            noteId: context?.noteId,
            url: dialogResult.url,
            filenameHint: dialogResult.url.split('/').pop()?.split('?')[0]
          });

          if (!persisted) {
            return;
          }

          editor.update(() => {
            const imageNode = $createImageNode(persisted.relativePath, extractAltFromUrl(dialogResult.url));
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertNodes([imageNode]);
            } else {
              // Fallback: insert at end of document
              const root = $getRoot();
              root.append(imageNode);
            }
          });
        }
      } catch (error) {
        if (isRendererDevelopment()) {
          console.error('Failed to insert media:', error);
        }
      }
    }
  },
  {
    id: MOSS_CANVAS_SLASH_COMMAND_ID,
    label: 'Canvas',
    description: 'Create wireframes, flows, diagrams, or rough visual thinking',
    icon: LineSquiggle,
    keywords: [...MOSS_CANVAS_SLASH_ALIASES, 'draw', 'freehand', 'doodle'],
    category: 'media',
    execute: (editor) => {
      replaceCurrentLineWithNode(editor, () => {
        return $createSketchNode();
      });
    }
  },
  // ── Charts ──
  {
    id: 'chart-bar',
    label: 'Bar Chart',
    description: 'Visualize data as bars',
    icon: BarChart3,
    keywords: ['chart', 'bar', 'graph', 'visualization', 'data'],
    category: 'charts',
    execute: (editor) => {
      replaceCurrentLineWithNode(editor, () => {
        const config = createSampleChartConfig('bar');
        return $createChartNode(config);
      });
    }
  },
  {
    id: 'chart-line',
    label: 'Line Chart',
    description: 'Visualize trends over time',
    icon: LineChart,
    keywords: ['chart', 'line', 'graph', 'visualization', 'data', 'trend'],
    category: 'charts',
    execute: (editor) => {
      replaceCurrentLineWithNode(editor, () => {
        const config = createSampleChartConfig('line');
        return $createChartNode(config);
      });
    }
  },
  {
    id: 'chart-area',
    label: 'Area Chart',
    description: 'Visualize volume over time',
    icon: AreaChart,
    keywords: ['chart', 'area', 'graph', 'visualization', 'data', 'trend'],
    category: 'charts',
    execute: (editor) => {
      replaceCurrentLineWithNode(editor, () => {
        const config = createSampleChartConfig('area');
        return $createChartNode(config);
      });
    }
  },
  {
    id: 'chart-stacked-bar',
    label: 'Stacked Bar Chart',
    description: 'Visualize parts of a whole',
    icon: BarChart3,
    keywords: ['chart', 'stacked', 'bar', 'graph', 'visualization', 'data', 'percentage', 'part-to-whole'],
    category: 'charts',
    execute: (editor) => {
      replaceCurrentLineWithNode(editor, () => {
        const config = createSampleChartConfig('stacked-bar');
        return $createChartNode(config);
      });
    }
  }
  // moss-multi seam: hide-registry (A§9)
].filter((command) => !(command.id === 'emoji' && hidden('emoji-panel')) && !(command.id === 'media' && hidden('media-upload')));

/**
 * Filter commands based on search query
 */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return commands;

  const tokenize = (value: string): string[] =>
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0);

  const scoreMatch = (cmd: SlashCommand): number => {
    const label = cmd.label.toLowerCase();
    const description = cmd.description?.toLowerCase() ?? '';
    const keywords = (cmd.keywords ?? []).map((kw) => kw.toLowerCase());

    let score = 0;

    if (label === normalizedQuery) score += 1000;
    if (label.startsWith(normalizedQuery)) score += 500;
    if (tokenize(label).some((token) => token.startsWith(normalizedQuery))) score += 300;
    if (label.includes(normalizedQuery)) score += 150;

    if (keywords.some((kw) => kw === normalizedQuery)) score += 220;
    if (keywords.some((kw) => kw.startsWith(normalizedQuery))) score += 160;
    if (keywords.some((kw) => kw.includes(normalizedQuery))) score += 120;

    if (description) {
      if (tokenize(description).some((token) => token.startsWith(normalizedQuery))) score += 60;
      if (description.includes(normalizedQuery)) score += 20;
    }

    return score;
  };

  return commands
    .map((cmd, index) => ({ cmd, score: scoreMatch(cmd), index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.cmd);
}

/**
 * Group commands by category
 */
export function groupCommandsByCategory(
  commands: SlashCommand[]
): Map<SlashCommandCategory, SlashCommand[]> {
  const grouped = new Map<SlashCommandCategory, SlashCommand[]>();

  // Initialize in order
  for (const category of CATEGORY_ORDER) {
    grouped.set(category, []);
  }

  // Group commands
  for (const command of commands) {
    const existing = grouped.get(command.category) ?? [];
    existing.push(command);
    grouped.set(command.category, existing);
  }

  // Remove empty categories
  for (const [category, cmds] of grouped) {
    if (cmds.length === 0) {
      grouped.delete(category);
    }
  }

  return grouped;
}
