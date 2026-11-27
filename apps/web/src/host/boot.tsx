// moss's renderer entry on the web, the analog of R/main.tsx (A§4.3): the bridge is installed before App's module
// evaluates, App keeps Jotai's default store (no Provider) inside Start's StrictMode root, error analytics install
// as in main.tsx, and /pdf-export (or ?mossMode=pdf-export) renders PdfExportApp instead, which prints once ready
// (R4). The input-refusal notice sits beside App.
import { useEffect, type ComponentType } from 'react';
import { readyWhenShellRenders } from './app-state.ts';
import { auth } from './auth.ts';
import { setSignedIn } from './vault-name.ts';
import { closeDocsToWrites, endTrashedDocs, pauseDocWrites, reaskDocRoles, reopenDocs, severDocSessions, waitDocsAcked } from './collab/doc-session.ts';
import { anyTerminal, subscribeTerminal } from './collab/terminal.ts';
import { ImageContextMenu } from './media/ImageContextMenu.tsx';
import { ReloadConfirmation } from './surfaces/ReloadConfirmation.tsx';
import { SignOutConfirmation } from './surfaces/SignOutConfirmation.tsx';
import { TrashConfirmation } from './surfaces/TrashConfirmation.tsx';
import { takeGateAnswer } from './access.ts';
import { docIdFromPath, folderIdFromPath, installBridge, WORKSPACE, type Bridge } from './bridge/index.ts';
import { enableFrameDocument } from './html-frame.ts';
import { inbox } from './inbox.ts';
import { installBackspaceGuard } from './opening-guard.ts';
import { printWhenReady } from './pdf-print.ts';
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

/**
 * A share link to a note, opened signed in (T9.54): the caller's listing does not carry the note unless they own it or
 * hold a grant on it, and moss's startup selection keeps its newest listed note over a note its list lacks. The route's
 * gate has already read the note with the tab's token, so before moss mounts that answer goes into moss's note store
 * (not its list: the note gets no sidebar row) as the note the tab is on, and startup selection keeps it. A note the
 * listing carries is left to moss. Nothing here grants access: the gate's answer is the server's, and the pane's
 * socket and every later request present the token again. A listing read that fails concludes nothing (R10), so the
 * gate's answer is used all the same, and a later listing that carries the note replaces the record and the role.
 */
async function openLinkedNote(bridge: Bridge): Promise<void> {
  const docId = docIdFromPath(window.location.pathname);
  const opened = docId ? takeGateAnswer(docId) : null;
  if (!docId || !opened || !new URLSearchParams(window.location.search).has('share') || auth.get().status !== 'signed-in') return;
  const listed = await bridge.notes.getAll().catch(() => null);
  if (listed?.some((note) => note.id === docId)) return;
  bridge[WORKSPACE].admit(opened.doc);
  const record = await bridge.notes.getById(docId).catch(() => undefined);
  if (!record) return;
  // Loaded after the bridge is installed, as moss's own modules must be (A§4.3).
  const [{ getDefaultStore }, { activeNoteIdAtom, mapNoteMetadataToNoteEntity }, { noteEntityAtom }] = await Promise.all([
    import('jotai'), import('@moss/shared/state/atoms'), import('@moss/shared/state/note-atoms'),
  ]);
  const store = getDefaultStore();
  store.set(noteEntityAtom(docId), mapNoteMetadataToNoteEntity(record));
  store.set(activeNoteIdAtom, docId);
}

/** Starts the guard that keeps a note opened outside the listing off moss's list (unlisted-notes.ts, T9.56). */
async function keepUnlistedNotesOffTheList(bridge: Bridge): Promise<void> {
  // Loaded after the bridge is installed, as moss's own modules must be (A§4.3).
  const [{ getDefaultStore }, { keepUnlistedNotesOffTheList: keep }] = await Promise.all([import('jotai'), import('./unlisted-notes.ts')]);
  keep(getDefaultStore(), bridge[WORKSPACE].outsideListing);
}

export async function bootMoss(): Promise<{ default: ComponentType }> {
  const bridge = installBridge(
    auth,
    createTrashGuard({ close: closeDocsToWrites, waitAcked: waitDocsAcked, confirm: askTrashConfirmation, end: endTrashedDocs }),
    (event) => {
      inbox.receive(event);
      reaskDocRoles(event);
    },
    reopenDocs,
  );
  // HTML blocks run live in the Worker's sandboxed frame document (A§16).
  enableFrameDocument();
  // A share link's note is read beside the imports below; it is in moss's store before moss mounts (T9.54).
  const linked = openLinkedNote(bridge).catch(() => undefined);
  const analytics = await import('@moss-desktop/renderer/error-analytics');
  analytics.installRendererErrorAnalytics();
  // A note the tab opened outside the listing never enters moss's list, whichever path opens it (T9.56).
  const unlisted = keepUnlistedNotesOffTheList(bridge).catch(() => undefined);
  if (window.location.pathname === '/pdf-export' || new URLSearchParams(window.location.search).get('mossMode') === 'pdf-export') {
    const { default: PdfExportApp } = await import('@moss-desktop/renderer/PdfExportApp');
    function PdfExportPage() {
      useEffect(() => printWhenReady(), []);
      return <PdfExportApp />;
    }
    return { default: PdfExportPage };
  }
  const [{ default: App }, { ShareDialogHost }, { DocumentTitle }] = await Promise.all([
    import('@moss-desktop/renderer/App'), import('./surfaces/ShareDialog.tsx'), import('./document-title.tsx'),
  ]);
  function MossShell() {
    useEffect(() => readyWhenShellRenders(), []);
    useEffect(() => installBackspaceGuard(), []);
    useEffect(() => { void revealLandingFolder(bridge); }, []);
    useEffect(() => { void inbox.refresh(); }, []);
    useEffect(() => {
      setSignedIn(auth.get().status === 'signed-in');
      return auth.subscribe((state) => { setSignedIn(state.status === 'signed-in'); });
    }, []);
    useEffect(() => auth.subscribe((state) => {
      if (state.status === 'signed-out') severDocSessions();
      else pauseDocWrites(state.status === 'signing-out');
    }), []);
    // A note whose socket the server closed as session-ended asks the session once; if it is gone the whole tab ends.
    useEffect(() => subscribeTerminal(() => {
      if (anyTerminal('session-ended')) void auth.confirmSession();
    }), []);
    return (
      <>
        <App />
        <SignOutConfirmation />
        <ImageContextMenu />
        <TrashConfirmation />
        <ReloadConfirmation />
        <ShareDialogHost />
        <DocumentTitle />
      </>
    );
  }
  await linked;
  await unlisted;
  return { default: MossShell };
}
