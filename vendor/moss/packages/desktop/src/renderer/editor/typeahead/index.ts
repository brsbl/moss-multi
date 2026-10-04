// ported-from: packages/desktop/src/renderer/editor/typeahead/index.ts @ 762abb777
// Shared typeahead components and hooks
export { TypeaheadMenu } from './TypeaheadMenu';
export { useTypeahead } from './useTypeahead';
export { mentionSearch } from './mentionSearch';
export { useFloatingPosition } from './useFloatingPosition';
export { HoverCard } from './HoverCard';
export type {
  TypeaheadItem,
  TypeaheadPosition,
  TypeaheadState,
  TypeaheadTriggerConfig,
  TypeaheadMenuProps
} from './types';
export type { HoverCardPosition, HoverCardProps } from './HoverCard';
export type { UseFloatingPositionOptions, UseFloatingPositionReturn, VirtualAnchor } from './useFloatingPosition';
export { TYPEAHEAD_DEFAULTS } from './types';
