// The web window.electronAPI (A§9), installed whole before moss's App module evaluates: every namespace and
// subscription exists, because moss calls some unconditionally. At T0.5a only the workspace listing is real
// (GET /api/workspace); T0.5b adds the inventory, the hide registry and the rest of the A§9 table.

/** moss's NoteMetadataRecord: timestamps in seconds, folders as `Notes/...` paths. */
export interface NoteMetadata {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folderPath: string;
  lastOpenedAt: number | null;
  trashedAt: number | null;
}

/** `GET /api/workspace`: the active vault and its docs, timestamps in epoch ms (A§6). */
export interface WorkspaceListing {
  vault: { id: string; name: string };
  docs: { id: string; title: string; createdAt: number; updatedAt: number }[];
}

export interface BridgeOptions {
  /** The current path; `/d/$docId` names moss's window-context startup note (A§4.2). */
  pathname: () => string;
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

const ROOT_FOLDER = 'Notes';
const THEME_KEY = 'moss_theme';
type ThemeChoice = 'system' | 'light' | 'dark';

const seconds = (ms: number) => Math.floor(ms / 1000);
const noop = () => undefined;
const unsubscribe = () => noop;
const none = async () => undefined;
const empty = async () => [];
const unavailable = (what: string) => async () => {
  throw new Error(`${what} is not available on the web yet`);
};

export function docIdFromPath(pathname: string): string | null {
  const match = /^\/d\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function toNoteMetadata(doc: WorkspaceListing['docs'][number]): NoteMetadata {
  return {
    id: doc.id,
    title: doc.title,
    createdAt: seconds(doc.createdAt),
    updatedAt: seconds(doc.updatedAt),
    folderPath: ROOT_FOLDER,
    lastOpenedAt: null,
    trashedAt: null,
  };
}

export function createBridge({ pathname, fetch: fetcher = fetch.bind(globalThis), storage = null }: BridgeOptions) {
  let listing: Promise<NoteMetadata[]> | null = null;
  const notes = () => {
    listing ??= fetcher('/api/workspace', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(async (response) => {
      if (!response.ok) throw new Error(`GET /api/workspace: ${response.status}`);
      return ((await response.json()) as WorkspaceListing).docs.map(toNoteMetadata);
    });
    // A failed read is retried on the next call rather than cached.
    listing.catch(() => {
      listing = null;
    });
    return listing;
  };
  const byId = async (id: string) => (await notes()).find((note) => note.id === id);
  const theme = (): ThemeChoice => {
    const stored = storage?.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  };

  return {
    notes: {
      getAll: () => notes(),
      getMetadataByIds: async (ids: string[]) => (await notes()).filter((note) => ids.includes(note.id)),
      getById: async (id: string) => {
        const note = await byId(id);
        return note ? { ...note, content: '', stickyTabs: [] } : undefined;
      },
      getContent: async (id: string) => ((await byId(id)) ? { id, content: '', version: 1 } : undefined),
      getHeadings: empty,
      create: unavailable('Creating a note'),
      update: async (id: string) => {
        const note = await byId(id);
        return note ? { ...note, stickyTabs: [] } : undefined;
      },
      delete: async () => false,
      restore: none,
      search: empty,
      showInFinder: none,
      onExternalFileOpen: unsubscribe,
      onInternalFileOpen: unsubscribe,
      onDiskChange: unsubscribe,
      onMetadataReindexed: unsubscribe,
      onRequestFlush: unsubscribe,
      flushComplete: none,
    },
    folders: {
      list: empty,
      create: unavailable('Creating a folder'),
      rename: unavailable('Renaming a folder'),
      delete: async () => false,
      moveNotes: empty,
      moveFolder: unavailable('Moving a folder'),
      showInFinder: none,
    },
    agent: {
      execute: unavailable('The agent'),
      cancel: none,
      cancelByTabId: none,
      onStream: unsubscribe,
    },
    chat: { getMessages: empty },
    checkpoints: { getAll: empty },
    files: { search: empty, listDirectory: empty, open: empty },
    images: {
      save: unavailable('Image upload'),
      pick: empty,
      persistUrl: unavailable('Saving a remote image'),
      copyFromPath: unavailable('Copying a local image'),
      copyFromNoteAsset: unavailable('Copying an image'),
    },
    htmlPreview: { ensure: async () => null, onMaterialized: unsubscribe, onFailed: unsubscribe },
    videoThumbnail: { ensure: async () => null, onMaterialized: unsubscribe },
    system: {
      showEmojiPanel: none,
      getMediaServerInfo: async () => null,
      getGlobalShortcut: async () => ({ quickCapture: '', enabled: false }),
      setGlobalShortcut: async () => false,
      setGlobalShortcutEnabled: none,
      createWindow: async () => ({ action: 'created' as const, windowId: 1 }),
      getWindowContext: async () => ({ windowId: 1, initialNoteId: docIdFromPath(pathname()), launchReason: 'initial-launch' as const, openedFromWindowId: null }),
      setFocusedNoteId: none,
      startWindowDrag: none,
      moveWindowDrag: none,
      endWindowDrag: none,
      onGlobalShortcutActivated: unsubscribe,
      waitForReady: none,
    },
    filesystem: {
      openFolderDialog: empty,
      openFileDialog: empty,
      readDirectory: async (path: string) => ({ path, entries: [] }),
      getHomeDirectory: async () => '',
      readFile: unavailable('Reading a local file'),
    },
    grantedDirs: { list: empty, grant: empty, revoke: empty },
    externalNotes: { close: async () => false, closeByRoot: empty, resolveLink: async () => null },
    update: { install: none, onReady: unsubscribe },
    analytics: { capture: none },
    shell: { revealPath: none },
    settings: {
      getNoteIntelligence: async () => true,
      setNoteIntelligence: none,
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
      pickWorkspaceFolder: async () => null,
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

/** Installs the bridge on `window` before App's module evaluates (A§4.3). */
export function installBridge(): Bridge {
  const bridge = createBridge({ pathname: () => window.location.pathname, storage: localStorageOrNull() });
  (window as unknown as { electronAPI: Bridge }).electronAPI = bridge;
  return bridge;
}
