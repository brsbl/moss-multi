// ported-from: packages/desktop/src/common/nodeTypeMap.ts @ 762abb777
import type { NoteNodeType } from './noteTypes';

/**
 * Node type mapping from Lexical node types to our categories.
 * Maps Lexical's internal node type strings to NoteNodeType values for content analysis.
 * A null value indicates the node type should be skipped (internal/structural nodes).
 */
export const NODE_TYPE_MAP: Record<string, NoteNodeType | null> = {
  paragraph: 'paragraph',
  heading: 'heading',
  listitem: 'listitem',
  'checklist-item': 'checklist',
  code: 'code',
  'code-highlight': null, // Skip code highlight tokens (internal to code blocks)
  table: 'table',
  tablerow: null, // Skip table rows (counted via table)
  tablecell: null, // Skip table cells (counted via table)
  image: 'image',
  chart: 'chart',
  sketch: 'sketch',
  link: 'link',
  'file-link': 'fileLink',
  formula: 'formula',
  text: 'text',
  linebreak: null,
  root: null,
  quote: null,
  horizontalrule: null,
  'horizontal-rule': null,
  tab: null
};
