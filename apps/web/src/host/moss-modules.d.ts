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
