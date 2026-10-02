// ported-from: packages/desktop/src/renderer/editor/plugins/code-block/index.ts @ 762abb777
/**
 * Code block plugins for enhanced code editing
 *
 * Note: CodeBlockDecoratorPlugin, CodeBlockExitPlugin, and CodeSelectAllPlugin
 * have been replaced by the CodeBlockNode DecoratorNode which handles all
 * code block UI inline (toolbar, navigation handled by DecoratorBlockPlugin).
 */

export { CodeHighlighterPlugin } from './CodeHighlighterPlugin';
export { CodeBlockToolbar } from './CodeBlockToolbar';
export {
  CORE_LANGUAGES,
  LANGUAGE_MAP,
  LANGUAGE_ALIASES,
  resolveLanguage,
  getLanguageLabel,
  getPrismKey,
  type LanguageDefinition
} from './languages';
export { CODE_THEMES, DEFAULT_THEME, getThemeById, getThemeLabel, type CodeBlockTheme } from './themes';
