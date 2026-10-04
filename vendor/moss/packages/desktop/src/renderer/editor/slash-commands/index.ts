// ported-from: packages/desktop/src/renderer/editor/slash-commands/index.ts @ 762abb777
export { SlashCommandPlugin } from './SlashCommandPlugin';
export { DEFAULT_SLASH_COMMANDS, filterCommands, groupCommandsByCategory } from './registry';
export type { SlashCommand, SlashCommandCategory } from './types';
export { CATEGORY_LABELS, CATEGORY_ORDER } from './types';
