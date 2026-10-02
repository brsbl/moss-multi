// Vendored moss modules the host imports through vite's @moss-desktop alias. Declared here so apps/web's
// typecheck stops at the vendor boundary: moss's own tsconfig checks moss upstream, and the vendor tree stays
// byte-identical (A§2.1).
declare module '@moss-desktop/renderer/editor/plugins/code-block/prism-setup' {}

declare module '@moss-desktop/renderer/App' {
  import type { ComponentType } from 'react';
  const App: ComponentType;
  export default App;
}

declare module '@moss-desktop/renderer/error-analytics' {
  export function installRendererErrorAnalytics(): void;
}

declare module '@moss-desktop/renderer/PdfExportApp' {
  import type { ComponentType } from 'react';
  const PdfExportApp: ComponentType;
  export default PdfExportApp;
}

declare module '@moss-desktop/renderer/editor/utils/note-link-clipboard' {
  export interface MossNoteLinkClipboardPayload {
    noteId: string;
    noteTitle: string;
    wikiLink: string;
  }
  export function buildCopyNoteLinkClipboardData(input: {
    noteId: string;
    noteTitle: string;
    folderPath?: string | null;
    filesystemPath?: string | null;
    headingText?: string | null;
  }): { payload: MossNoteLinkClipboardPayload; plainText: string };
  export function buildMossNoteLinkClipboardHtml(payload: MossNoteLinkClipboardPayload): string;
}
