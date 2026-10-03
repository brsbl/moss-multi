import type { Plugin } from 'vite';

/** A browser caches failed module fetches for the page's lifetime. Give optional-surface attempts fresh URLs.
 * Run after chunk names are assigned, preserving Vite's preload wrapper and the shared dependencies' identities.
 */
export function recoverableImports(): Plugin {
  return {
    name: 'moss-recoverable-imports',
    apply: 'build',
    renderChunk(code, chunk) {
      if (!chunk.moduleIds.some(id => id.endsWith('/desktop/src/renderer/App.tsx'))) return null;
      let imports = 0;
      const patched = code.replace(
        /\bimport\(\s*(['"])(\.\/(?:CommandPaletteOverlay|SettingsModal|FeedbackDialog|UpdateWidget|TrashedNotesPanelContent)-[^'"]+\.js)\1\s*\)/g,
        (_match, quote: string, path: string) => {
          imports += 1;
          return `import(${quote}${path}?moss-attempt=${quote}+Date.now())`;
        },
      );
      if (imports !== 5) this.error(`Expected five recoverable shell imports, found ${imports}`);
      return { code: patched, map: null };
    },
  };
}
