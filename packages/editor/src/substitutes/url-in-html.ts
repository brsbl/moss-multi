// Kept apart from web-asset-url.ts so it can be tested without the editor registry; that substitute loads under
// apps/web's path, so it imports this through @moss-editor/.
/**
 * `scheme:rest` URLs. A match starts only where a run of scheme characters starts and the URL (group 1) at the run's
 * first letter, as `/[a-z][a-z\d+.-]*:[^\s"'<>]+/gi` found it, but in linear time (docs/METHOD.md).
 */
export const URL_IN_HTML = /(?<![a-z\d+.-])[\d+.-]*([a-z][a-z\d+.-]*:[^\s"'<>]+)/gi;
