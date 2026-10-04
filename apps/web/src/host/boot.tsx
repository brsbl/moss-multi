// moss's renderer entry on the web, the analog of R/main.tsx (A§4.3): the bridge is installed before App's module
// evaluates, App keeps Jotai's default store (no Provider) inside Start's StrictMode root, error analytics install
// as in main.tsx, and ?mossMode=pdf-export renders PdfExportApp instead. The input-refusal notice sits beside App.
import { useEffect, type ComponentType } from 'react';
import { readyWhenShellRenders } from './app-state.ts';
import { auth } from './auth.ts';
import { pauseDocWrites, severDocSessions } from './collab/doc-session.ts';
import { ImageContextMenu } from './media/ImageContextMenu.tsx';
import { SignOutConfirmation } from './surfaces/SignOutConfirmation.tsx';
import { installBridge } from './bridge/index.ts';
import { installBackspaceGuard } from './opening-guard.ts';

export async function bootMoss(): Promise<{ default: ComponentType }> {
  installBridge(auth);
  const analytics = await import('@moss-desktop/renderer/error-analytics');
  analytics.installRendererErrorAnalytics();
  if (new URLSearchParams(window.location.search).get('mossMode') === 'pdf-export') {
    return import('@moss-desktop/renderer/PdfExportApp');
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
        <ImageContextMenu />
      </>
    );
  }
  return { default: MossShell };
}
