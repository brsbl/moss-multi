// ported-from: packages/desktop/src/common/utils.ts @ 762abb777
/**
 * Shared utility functions for the desktop package.
 */

/**
 * Returns the current Unix timestamp in seconds (not milliseconds).
 */
export const currentUnixSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Strip wiki-link syntax from text: `[[Title|noteId]]` → `Title`, `[[Title]]` → `Title`.
 * Used to clean heading text that may contain inline FileLinkNodes.
 */
export const stripWikiLinks = (text: string): string =>
  text.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
