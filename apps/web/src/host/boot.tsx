// moss's renderer entry on the web, the analog of R/main.tsx (A§4.3): the bridge is installed before App's module
// evaluates, App keeps Jotai's default store (no Provider) inside Start's StrictMode root, error analytics install
// as in main.tsx, and /pdf-export (or ?mossMode=pdf-export) renders PdfExportApp instead, which prints once ready
// (R4). The input-refusal notice sits beside App.
import { useEffect, type ComponentType } from 'react';
import { readyWhenShellRenders } from './app-state.ts';
import { auth } from './auth.ts';
import { pauseDocWrites, severDocSessions } from './collab/doc-session.ts';
import { SignOutConfirmation } from './surfaces/SignOutConfirmation.tsx';
import { installBridge } from './bridge/index.ts';
import { installBackspaceGuard } from './opening-guard.ts';
import { printWhenReady } from './pdf-print.ts';

export async function bootMoss(): Promise<{ default: ComponentType }> {
  installBridge(auth);
  const analytics = await import('@moss-desktop/renderer/error-analytics');
  analytics.installRendererErrorAnalytics();
  if (window.location.pathname === '/pdf-export' || new URLSearchParams(window.location.search).get('mossMode') === 'pdf-export') {
    const { default: PdfExportApp } = await import('@moss-desktop/renderer/PdfExportApp');
    function PdfExportPage() {
      useEffect(() => printWhenReady(), []);
      return <PdfExportApp />;
    }
    return { default: PdfExportPage };
  }
  const { default: App } = await import('@moss-desktop/renderer/App');
  function MossShell() {
    useEffect(() => readyWhenShellRenders(), []);
    useEffect(() => installBackspaceGuard(), []);
    useEffect(() => auth.subscribe((state) => {
      if (state.status === 'signed-out') severDocSessions();
      else pauseDocWrites(state.status === 'signing-out');
    }), []);
    return (
      <>
        <App />
        <SignOutConfirmation />
      </>
    );
  }
  return { default: MossShell };
}
