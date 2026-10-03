// The web window.electronAPI (A§9), installed whole before moss's App module evaluates: every namespace and
// subscription exists, because moss calls some unconditionally. inventory.ts says how each method is treated;
// a staged method is minimally real until its milestone, and its entry points are hidden through the registry.
import {
  buildCopyNoteLinkClipboardData,
  buildMossNoteLinkClipboardHtml,
} from '@moss-desktop/renderer/editor/utils/note-link-clipboard';
import { displayTitle, liveTitle, writeLiveTitle } from '../collab/title-binding.ts';
import { askDocAccess, rememberRole } from '../access.ts';

/** moss's NoteMetadataRecord: timestamps in seconds, folders as `Notes/...` paths. */
export interface NoteMetadata {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folderPath: string;
  lastOpenedAt: number | null;
  trashedAt: number | null;
  pinned?: boolean;
  pinnedAt?: number | null;
}

/** A doc as the API returns it (A§6): timestamps in epoch ms, and the caller's role where the API says it. */
export interface ApiDoc {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  role?: string;
}

/** `GET /api/workspace`: the active vault and its docs. */
export interface WorkspaceListing {
  vault: { id: string; name: string };
  docs: ApiDoc[];
}

/** The browser behind the bridge; injected in unit tests. */
export interface BrowserHooks {
  origin: string;
  open(url: string): void;
  replacePath(path: string): void;
  onPopState(listener: () => void): () => void;
  copy(text: string, html: string): Promise<void>;
}

export interface BridgeOptions {
  /** The current path; `/d/$docId` names moss's window-context startup note (A§4.2). */
  pathname: () => string;
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  browser?: BrowserHooks;
}

type ThemeChoice = 'system' | 'light' | 'dark';
type Listener<T extends unknown[]> = (...args: T) => void;

interface UpdateInput {
  title?: string;
  content?: string;
  pinned?: boolean;
  pinnedAt?: number | null;
  layoutMetadata?: unknown;
  collapsedHeadings?: string[];
  [field: string]: unknown;
}

const ROOT_FOLDER = 'Notes';
/** moss's display name for a note with no title; never authored into the doc (A§5.1 seed). */
const UNTITLED = 'Untitled';
const THEME_KEY = 'moss_theme';
const PINS_KEY = 'moss-multi:pins';
const NOTE_INTELLIGENCE_KEY = 'moss-multi:note-intelligence';
const layoutKey = (id: string) => `moss-multi:layout:${id}`;
const collapsedKey = (id: string) => `moss-multi:collapsed-headings:${id}`;

type Method<R> = (...args: unknown[]) => Promise<R>;

const seconds = (ms: number) => Math.floor(ms / 1000);
const noop = () => undefined;
/** A subscription that never fires; it must still return an unsubscriber. */
const silent: (callback?: unknown) => () => void = () => noop;
const none: Method<void> = async () => undefined;
const empty: Method<never[]> = async () => [];
const nothing: Method<null> = async () => null;
const refuse = (what: string): Method<never> => async () => {
  throw new Error(`moss-multi: ${what}`);
};
const later = (what: string, milestone: number) => refuse(`${what} is not available on the web until M${milestone}`);
const unavailable = (what: string) => refuse(`${what} is not available on the web`);

export function docIdFromPath(pathname: string): string | null {
  const match = /^\/d\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function toNoteMetadata(doc: ApiDoc): NoteMetadata {
  return {
    id: doc.id,
    title: doc.title.trim() ? doc.title : UNTITLED,
    createdAt: seconds(doc.createdAt),
    updatedAt: seconds(doc.updatedAt),
    folderPath: ROOT_FOLDER,
    lastOpenedAt: null,
    trashedAt: null,
  };
}

function readJson<T>(storage: BridgeOptions['storage'], key: string): T | undefined {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(storage: BridgeOptions['storage'], key: string, value: unknown): void {
  if (value === undefined || value === null) storage?.removeItem(key);
  else storage?.setItem(key, JSON.stringify(value));
}

const inertBrowser: BrowserHooks = {
  origin: 'http://localhost',
  open: noop,
  replacePath: noop,
  onPopState: () => noop,
  copy: async () => undefined,
};

export function createBridge({ pathname, fetch: fetcher = fetch.bind(globalThis), storage = null, browser = inertBrowser }: BridgeOptions) {
  const request = (path: string, init: RequestInit = {}) =>
    fetcher(path, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...init.headers } });

  // Every doc this tab has seen, from the listing or from a create; the listing promise is the boot read.
  const known = new Map<string, NoteMetadata>();
  let listing: Promise<NoteMetadata[]> | null = null;
  const pins = () => readJson<Record<string, number>>(storage, PINS_KEY) ?? {};
  const withLocal = (listed: NoteMetadata): NoteMetadata => {
    // A doc this tab binds is named by its live Y.Text title, never by a listing read before a rename (A§9).
    const live = liveTitle(listed.id);
    const note = live === null ? listed : { ...listed, title: displayTitle(live) };
    const pinnedAt = pins()[note.id];
    return pinnedAt ? { ...note, pinned: true, pinnedAt } : note;
  };
  const notes = () => {
    listing ??= request('/api/workspace').then(async (response) => {
      if (!response.ok) throw new Error(`GET /api/workspace: ${response.status}`);
      const rows = ((await response.json()) as WorkspaceListing).docs;
      for (const row of rows) rememberRole(row.id, row.role);
      const docs = rows.map(toNoteMetadata);
      for (const doc of docs) known.set(doc.id, doc);
      return docs;
    });
    // A failed read is retried on the next call rather than cached.
    listing.catch(() => {
      listing = null;
    });
    return listing.then((docs) => docs.map(withLocal));
  };
  const byId = async (id: string): Promise<NoteMetadata | undefined> => {
    if (!known.has(id)) await notes();
    if (!known.has(id)) {
      // A doc shared with the caller that the listing does not carry, opened by its URL.
      const answer = await askDocAccess(id, fetcher);
      if (answer.kind === 'open' && !known.has(id)) known.set(id, toNoteMetadata(answer.doc));
    }
    const note = known.get(id);
    return note && withLocal(note);
  };
  const record = (note: NoteMetadata) => ({
    ...note,
    stickyTabs: [],
    collapsedHeadings: readJson<string[]>(storage, collapsedKey(note.id)),
  });
  const theme = (): ThemeChoice => {
    const stored = storage?.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  };
  const docUrl = (id: string) => new URL(`/d/${encodeURIComponent(id)}`, browser.origin).href;

  return {
    notes: {
      getAll: () => notes(),
      getMetadataByIds: async (ids: string[]) => (await notes()).filter((note) => ids.includes(note.id)),
      getById: async (id: string) => {
        const note = await byId(id);
        // A doc that will bind gets no content from REST: the binding fills it (A§9).
        return note ? { ...record(note), content: '', layoutMetadata: readJson(storage, layoutKey(id)) } : undefined;
      },
      getContent: async (id: string) => ((await byId(id)) ? { id, content: '', version: 1 } : undefined),
      getFrontmatterSuggestions: async () => ({}),
      getHeadings: empty,
      create: async (title: string, folderPath: string = ROOT_FOLDER) => {
        // Folders land in M2; until then every note lives at the vault root.
        if (folderPath !== ROOT_FOLDER) throw new Error('moss-multi: folders are not available on the web until M2');
        // "Untitled" is moss's placeholder name; the doc's title starts empty (A§5.1).
        const body = title.trim() && title.trim() !== UNTITLED ? { title: title.trim() } : {};
        const response = await request('/api/docs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`POST /api/docs: ${response.status}`);
        const created = (await response.json()) as { doc: ApiDoc; role?: string };
        rememberRole(created.doc.id, created.role);
        const note = toNoteMetadata(created.doc);
        known.set(note.id, note);
        listing = null;
        return { ...record(note), content: '' };
      },
      update: async (id: string, input: UpdateInput = {}) => {
        // Content reaches a doc only through its binding or a server merge; the bridge has no path that could
        // wipe one (P:Tech; L§4.6 D-F3).
        if ('content' in input) throw new Error(`moss-multi: a content write through the bridge is refused for ${id}`);
        let note = await byId(id);
        if (!note) return undefined;
        if (typeof input.title === 'string' && !writeLiveTitle(id, input.title)) {
          // A doc no pane of this tab binds: the DocDO writes the title into its Y.Text (A§5.1 renameTitle).
          const response = await request(`/api/docs/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: input.title }),
          });
          if (!response.ok) throw new Error(`PATCH /api/docs/${id}: ${response.status}`);
          const answer = (await response.json()) as { doc: ApiDoc };
          note = toNoteMetadata(answer.doc);
          known.set(id, note);
          listing = null;
        }
        if ('pinned' in input || 'pinnedAt' in input) {
          const next = pins();
          if (input.pinned === false) delete next[id];
          else next[id] = input.pinnedAt ?? seconds(Date.now());
          writeJson(storage, PINS_KEY, Object.keys(next).length > 0 ? next : null);
        }
        if ('layoutMetadata' in input) writeJson(storage, layoutKey(id), input.layoutMetadata);
        if ('collapsedHeadings' in input) writeJson(storage, collapsedKey(id), input.collapsedHeadings);
        return record(withLocal(note));
      },
      delete: later('Trash', 2),
      restore: later('Restoring from Trash', 2),
      search: async ({ query, limit, searchTrashed }: { query: string; limit?: number; searchTrashed?: boolean }) => {
        // Title matches over the listing until search lands in M3.
        const needle = query.trim().toLowerCase();
        if (searchTrashed || !needle) return [];
        return (await notes())
          .filter((note) => note.title.toLowerCase().includes(needle))
          .slice(0, limit ?? 50)
          .map((note) => ({ id: note.id, title: note.title, folderPath: note.folderPath, updatedAt: note.updatedAt, matchType: 'title' as const }));
      },
      getFilesystemPath: async (id: string) => docUrl(id),
      setOpenFileWatchTargets: none,
      copyLinkToClipboard: async (id: string, input: { noteTitle?: string } = {}) => {
        const note = await byId(id);
        const { payload } = buildCopyNoteLinkClipboardData({ noteId: id, noteTitle: input.noteTitle ?? note?.title ?? '', folderPath: ROOT_FOLDER });
        try {
          await browser.copy(docUrl(id), buildMossNoteLinkClipboardHtml(payload));
          return true;
        } catch {
          return false;
        }
      },
      showInFinder: none,
      getPdfExportSession: nothing,
      createPdfExportSession: nothing,
      openPdfExportPreview: nothing,
      openPdfExportRenderSurface: nothing,
      exportPdf: unavailable('Exporting a PDF file'),
      exportMarkdown: async () => ({ canceled: true }),
      onExternalFileOpen: silent,
      onInternalFileOpen: (callback?: Listener<[string]>) =>
        browser.onPopState(() => {
          const id = docIdFromPath(pathname());
          if (id && callback) callback(id);
        }),
      onDiskChange: silent,
      onMetadataReindexed: silent,
      onRequestFlush: silent,
      flushComplete: none,
    },
    folders: {
      list: empty,
      create: later('Folders', 2),
      rename: later('Folders', 2),
      delete: later('Folders', 2),
      moveNotes: later('Moving notes into folders', 2),
      moveFolder: later('Folders', 2),
      showInFinder: none,
    },
    agent: {
      execute: unavailable('The agent'),
      cancel: none,
      cancelByTabId: none,
      onStream: silent,
    },
    chat: { getMessages: empty },
    checkpoints: { getAll: empty },
    files: { search: empty, listDirectory: empty, open: empty },
    images: {
      save: later('Uploading media', 3),
      pick: later('Uploading media', 3),
      persistUrl: later('Saving a remote image', 3),
      copyFromPath: unavailable('Copying a local file'),
      copyFromNoteAsset: later('Copying media between notes', 3),
    },
    htmlPreview: { ensure: nothing, onMaterialized: silent, onFailed: silent },
    webEmbedPreview: { ensure: nothing, subscribe: silent },
    videoThumbnail: { ensure: nothing, onMaterialized: silent },
    system: {
      showEmojiPanel: none,
      getMediaServerInfo: nothing,
      getGlobalShortcut: async () => ({ quickCapture: '', enabled: false }),
      setGlobalShortcut: async () => false,
      setGlobalShortcutEnabled: none,
      setImageAltTextMenuEnabled: none,
      // Open in New Window is a browser tab (R4).
      createWindow: async (input: { noteId?: string | null } = {}) => {
        browser.open(input.noteId ? docUrl(input.noteId) : new URL('/', browser.origin).href);
        return { action: 'created' as const, windowId: -1 };
      },
      getWindowContext: async () => ({ windowId: 1, initialNoteId: docIdFromPath(pathname()), launchReason: 'initial-launch' as const, openedFromWindowId: null }),
      // The address follows the focused note, so a reload or a copied URL reopens it (A§4.2).
      setFocusedNoteId: async (id: string | null) => {
        if (id && docIdFromPath(pathname()) !== id) browser.replacePath(`/d/${encodeURIComponent(id)}`);
      },
      startWindowDrag: none,
      moveWindowDrag: none,
      endWindowDrag: none,
      onGlobalShortcutActivated: silent,
      onNativeMenuCommand: silent,
      waitForReady: async () => {
        await notes().catch(() => undefined);
      },
    },
    filesystem: {
      openFolderDialog: empty,
      openFileDialog: empty,
      readDirectory: async (path: string) => ({ path, entries: [] }),
      getHomeDirectory: async () => '',
      readFile: unavailable('Reading a local file'),
    },
    grantedDirs: { list: empty, grant: empty, revoke: empty },
    externalNotes: { close: async () => false, closeByRoot: empty, resolveLink: nothing },
    update: { install: none, onReady: silent },
    analytics: {
      capture: async (event: string, properties: Record<string, unknown> = {}) => {
        if (event !== 'feedback_submitted') return;
        const response = await request('/api/feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: properties.feedback_text, email: properties.email, page: pathname() }),
        });
        if (!response.ok) throw new Error(`POST /api/feedback: ${response.status}`);
      },
    },
    shell: { revealPath: none },
    settings: {
      getNoteIntelligence: async () => storage?.getItem(NOTE_INTELLIGENCE_KEY) !== 'false',
      setNoteIntelligence: async (enabled: boolean) => storage?.setItem(NOTE_INTELLIGENCE_KEY, String(enabled)),
      getTheme: async () => theme(),
      setTheme: async (choice: ThemeChoice) => storage?.setItem(THEME_KEY, choice),
      isDefaultMdEditor: async () => true,
      setDefaultMdEditor: async () => true,
      getDefaultEditorPromptDismissed: async () => true,
      setDefaultEditorPromptDismissed: none,
    },
    appConfig: {
      getWorkspacePath: async () => ({ path: null, envOverride: false, effectivePath: '' }),
      setWorkspacePath: async () => ({ success: false, error: 'not available on the web' }),
      pickWorkspaceFolder: nothing,
      restartApp: none,
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage disabled: the theme still follows the in-memory atom
  }
}

function windowBrowser(): BrowserHooks {
  return {
    origin: window.location.origin,
    open: (url) => {
      window.open(url, '_blank', 'noopener');
    },
    // Moss keeps its own back and forward (A§9 navigation), so the address changes without the router: TanStack wraps
    // window.history.replaceState, and the route change it reports would remount moss's whole App.
    replacePath: (path) => History.prototype.replaceState.call(window.history, window.history.state, '', path),
    onPopState: (listener) => {
      window.addEventListener('popstate', listener);
      return () => window.removeEventListener('popstate', listener);
    },
    copy: async (text, html) => {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return navigator.clipboard.writeText(text);
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) }),
      ]);
    },
  };
}

/** Installs the bridge on `window` before App's module evaluates (A§4.3). */
export function installBridge(): Bridge {
  const bridge = createBridge({ pathname: () => window.location.pathname, storage: localStorageOrNull(), browser: windowBrowser() });
  (window as unknown as { electronAPI: Bridge }).electronAPI = bridge;
  return bridge;
}
