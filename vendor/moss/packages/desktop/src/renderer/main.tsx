// ported-from: packages/desktop/src/renderer/main.tsx @ 762abb777
// IMPORTANT: Prism must be set up BEFORE any @lexical/code imports
// This must be the first import in the application
import './editor/plugins/code-block/prism-setup';

import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter/wght-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import 'charter-webfont/charter.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PdfExportApp from './PdfExportApp';
import { installRendererErrorAnalytics } from './error-analytics';
import './styles.css';

installRendererErrorAnalytics();

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Failed to find root element');
}

const searchParams = new URLSearchParams(window.location.search);
const mossMode = searchParams.get('mossMode');

if (import.meta.env.DEV && mossMode === 'base-ui-sandbox') {
  const LazyBaseUiSandboxApp = React.lazy(async () => {
    const module = await import('./dev/base-ui-sandbox/BaseUiSandboxApp');
    return { default: module.BaseUiSandboxApp };
  });

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <React.Suspense fallback={<div className="p-6 text-sm text-ink-muted">Loading sandbox...</div>}>
        <LazyBaseUiSandboxApp />
      </React.Suspense>
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {mossMode === 'pdf-export' ? (
        <PdfExportApp />
      ) : (
        <App />
      )}
    </React.StrictMode>
  );
}
