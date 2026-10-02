// ported-from: packages/desktop/src/renderer/editor/plugins/code-block/languages.ts @ 762abb777
/**
 * Language registry for code block syntax highlighting.
 * Core languages are bundled; others can be lazy-loaded.
 */

export interface LanguageDefinition {
  /** Language identifier used in markdown fence (e.g., "javascript") */
  id: string;
  /** Display label for UI (e.g., "JavaScript") */
  label: string;
  /** Prism grammar key (null for plain text) */
  prismKey: string | null;
  /** File extensions associated with this language */
  extensions?: string[];
}

/**
 * Core languages bundled with the editor.
 * These are imported synchronously in CodeHighlighterPlugin.
 */
export const CORE_LANGUAGES: LanguageDefinition[] = [
  {
    id: 'javascript',
    label: 'JavaScript',
    prismKey: 'javascript',
    extensions: ['.js', '.mjs', '.cjs']
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    prismKey: 'typescript',
    extensions: ['.ts', '.mts', '.cts']
  },
  {
    id: 'jsx',
    label: 'JSX',
    prismKey: 'jsx',
    extensions: ['.jsx']
  },
  {
    id: 'tsx',
    label: 'TSX',
    prismKey: 'tsx',
    extensions: ['.tsx']
  },
  {
    id: 'python',
    label: 'Python',
    prismKey: 'python',
    extensions: ['.py', '.pyw']
  },
  {
    id: 'json',
    label: 'JSON',
    prismKey: 'json',
    extensions: ['.json']
  },
  {
    id: 'sql',
    label: 'SQL',
    prismKey: 'sql',
    extensions: ['.sql']
  },
  {
    id: 'css',
    label: 'CSS',
    prismKey: 'css',
    extensions: ['.css']
  },
  {
    id: 'html',
    label: 'HTML',
    prismKey: 'markup',
    extensions: ['.html', '.htm']
  },
  {
    id: 'markdown',
    label: 'Markdown',
    prismKey: 'markdown',
    extensions: ['.md', '.mdx']
  },
  {
    id: 'bash',
    label: 'Bash',
    prismKey: 'bash',
    extensions: ['.sh', '.bash']
  },
  {
    id: 'plaintext',
    label: 'Plain Text',
    prismKey: null,
    extensions: ['.txt']
  }
];

/**
 * Map of language ID to definition for quick lookup
 */
export const LANGUAGE_MAP = new Map<string, LanguageDefinition>(
  CORE_LANGUAGES.map((lang) => [lang.id, lang])
);

/**
 * Common language aliases that map to core languages
 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  text: 'plaintext',
  plain: 'plaintext',
  txt: 'plaintext',
  htm: 'html',
  md: 'markdown'
};

/**
 * Resolve a language string to a known language ID.
 * Handles aliases and case-insensitive matching.
 */
export function resolveLanguage(language: string | null | undefined): string {
  if (!language) return 'plaintext';

  const normalized = language.toLowerCase().trim();
  if (
    normalized.length === 0 ||
    normalized === 'undefined' ||
    normalized === 'null' ||
    normalized === 'none'
  ) {
    return 'plaintext';
  }

  // Check for exact match
  if (LANGUAGE_MAP.has(normalized)) {
    return normalized;
  }

  // Check aliases
  if (normalized in LANGUAGE_ALIASES) {
    return LANGUAGE_ALIASES[normalized];
  }

  // Return as-is for unknown languages (Prism may still support it)
  return normalized;
}

/**
 * Get the display label for a language ID
 */
export function getLanguageLabel(languageId: string): string {
  const resolved = resolveLanguage(languageId);
  const definition = LANGUAGE_MAP.get(resolved);
  return definition?.label ?? languageId;
}

/**
 * Get the Prism grammar key for a language ID
 */
export function getPrismKey(languageId: string): string | null {
  const resolved = resolveLanguage(languageId);
  const definition = LANGUAGE_MAP.get(resolved);
  return definition?.prismKey ?? resolved;
}
