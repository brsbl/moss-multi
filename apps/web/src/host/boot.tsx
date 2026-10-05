// moss's renderer entry on the web, the analog of R/main.tsx (A§4.3): the bridge is installed before App's module
// evaluates, App keeps Jotai's default store (no Provider) inside Start's StrictMode root, error analytics install
// as in main.tsx, and ?mossMode=pdf-export renders PdfExportApp instead. The input-refusal notice sits beside App.
import { useEffect, type ComponentType } from 'react';
import { readyWhenShellRenders } from './app-state.ts';
import { auth } from './auth.ts';
import { closeDocsToWrites, endTrashedDocs, pauseDocWrites, severDocSessions, waitDocsAcked } from './collab/doc-session.ts';
import { SignOutConfirmation } from './surfaces/SignOutConfirmation.tsx';
import { TrashConfirmation } from './surfaces/TrashConfirmation.tsx';
import { folderIdFromPath, installBridge, WORKSPACE, type Bridge } from './bridge/index.ts';
import { inbox } from './inbox.ts';
import { installBackspaceGuard } from './opening-guard.ts';
import { askTrashConfirmation, createTrashGuard } from './trash-guard.ts';

/** The `/f/$folderId` landing (A§4.2): once the listing names the folder, select it and expand its ancestors. */
async function revealLandingFolder(bridge: Bridge): Promise<void> {
  const folderId = folderIdFromPath(window.location.pathname);
  if (!folderId) return;
  await bridge.notes.getAll().catch(() => undefined);
  const folder = bridge[WORKSPACE].folderById(folderId);
  if (!folder) return;
  // Loaded after the bridge is installed, as moss's own modules must be (A§4.3).
  const [{ getDefaultStore }, { revealFolderPathAtom }] = await Promise.all([import('jotai'), import('@moss/shared/state/atoms')]);
  getDefaultStore().set(revealFolderPathAtom, folder.path);
}

export async function bootMoss(): Promise<{ default: ComponentType }> {
  const bridge = installBridge(
    auth,
    createTrashGuard({ close: closeDocsToWrites, waitAcked: waitDocsAcked, confirm: askTrashConfirmation, end: endTrashedDocs }),
    (event) => inbox.receive(event),
  );
  const analytics = await import('@moss-desktop/renderer/error-analytics');
  analytics.installRendererErrorAnalytics();
  if (new URLSearchParams(window.location.search).get('mossMode') === 'pdf-export') {
    return import('@moss-desktop/renderer/PdfExportApp');
  }
  const [{ default: App }, { ShareDialogHost }] = await Promise.all([import('@moss-desktop/renderer/App'), import('./surfaces/ShareDialog.tsx')]);
  function MossShell() {
    useEffect(() => readyWhenShellRenders(), []);
    useEffect(() => installBackspaceGuard(), []);
    useEffect(() => { void revealLandingFolder(bridge); }, []);
    useEffect(() => { void inbox.refresh(); }, []);
    useEffect(() => auth.subscribe((state) => {
      if (state.status === 'signed-out') severDocSessions();
      else pauseDocWrites(state.status === 'signing-out');
    }), []);
    return (
      <>
        <App />
        <SignOutConfirmation />
        <TrashConfirmation />
        <ShareDialogHost />
      </>
    );
  }
  return { default: MossShell };
}
