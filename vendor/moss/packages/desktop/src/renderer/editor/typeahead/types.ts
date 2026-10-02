// ported-from: packages/desktop/src/renderer/editor/typeahead/types.ts @ 762abb777
/**
 * Shared types for typeahead menus (@ mentions, [[ file links, / commands)
 */

export interface TypeaheadPosition {
  top: number;
  left: number;
}

export interface TypeaheadItem {
  id: string;
  label: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string; size?: number }>;
  category?: string;
  /** Any additional data specific to the typeahead type */
  data?: unknown;
}

export interface TypeaheadState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  position: TypeaheadPosition | null;
  triggerOffset: number | null;
}

export interface TypeaheadTriggerConfig {
  /** The character(s) that trigger the typeahead */
  trigger: string;
  /**
   * Whether trigger must be at word boundary (preceded by whitespace or start of line)
   * Default: true for single-char triggers like @ and /
   */
  requireWordBoundary?: boolean;
  /**
   * Characters that close the typeahead context (e.g., space after query)
   * Default: none
   */
  closingChars?: string[];
  /**
   * Characters that indicate completion (e.g., ]] for file links)
   * Default: none
   */
  completionChars?: string;
}

export interface TypeaheadMenuProps<T extends TypeaheadItem> {
  items: T[];
  selectedIndex: number;
  position: TypeaheadPosition;
  onSelect: (item: T) => void;
  onClose: () => void;
  renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
  emptyMessage?: string;
  searchingMessage?: string;
  width?: number;
  maxHeight?: number;
}

export const TYPEAHEAD_DEFAULTS = {
  width: 240,
  maxHeight: 256,
  itemHeight: 32,
  emptyHeight: 36,
  debounceMs: 100,
  menuOffsetY: 4,
  /** Height reserved for floating toolbar at bottom of editor */
  bottomToolbarHeight: 56
} as const;
