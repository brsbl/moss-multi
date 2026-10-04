// ported-from: packages/desktop/src/renderer/editor/slash-commands/types.ts @ 762abb777
import type { LexicalEditor } from 'lexical';
import type { LucideIcon } from 'lucide-react';

/**
 * Defines a slash command that can be invoked from the command palette.
 */
export type SlashCommand = {
  /** Unique identifier for the command */
  id: string;
  /** Display label shown in the command palette */
  label: string;
  /** Optional description shown below the label */
  description?: string;
  /** Lucide icon component to display */
  icon: LucideIcon;
  /** Keywords for filtering (searched along with label) */
  keywords?: string[];
  /** Node dependencies blocked by matching nested editor contexts */
  dependencies?: readonly unknown[];
  /** Command category for grouping */
  category: SlashCommandCategory;
  /** Execute the command (insert node, transform selection, etc.) */
  execute: (editor: LexicalEditor, context?: { noteId?: string }) => void;
};

export type SlashCommandCategory =
  | 'blocks'
  | 'inline'
  | 'media'
  | 'charts';

export const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  blocks: 'Blocks',
  inline: 'Inline',
  media: 'Media',
  charts: 'Charts'
};

export const CATEGORY_ORDER: SlashCommandCategory[] = ['blocks', 'inline', 'media', 'charts'];
