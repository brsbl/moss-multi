import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import { subscribeWorkspace } from '../workspace-channel.ts';
// The web window.electronAPI (A§9), installed whole before moss's App module evaluates: every namespace and
// subscription exists, because moss calls some unconditionally. inventory.ts says how each method is treated;
// a staged method is minimally real until its milestone, and its entry points are hidden through the registry.
import {
  buildCopyNoteLinkClipboardData,
  buildMossNoteLinkClipboardHtml,
} from '@moss-desktop/renderer/editor/utils/note-link-clipboard';
import { displayTitle, liveTitle, writeLiveTitle } from '../collab/title-binding.ts';
import { askDocAccess, rememberRole } from '../access.ts';
import { onNativeMenuCommand } from '../media/image-menu.ts';
import { chooseFilesInBrowser, createImagesApi } from '../media/uploads.ts';
import { setWikiCandidates } from '../wiki-links.ts';
import type { TrashGuard } from '../trash-guard.ts';

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
  /** Backlinks (A§15), on a doc whose backlinks this tab has read. */
  incomingLinks?: NoteLink[];
}

/** moss's NoteLink: one row of LinksSection. */
export interface NoteLink {
  noteId: string;
  title: string;
  folderPath?: string;
  updatedAt?: number;
}

/** moss's NoteSearchResult. */
export interface NoteSearchResult {
  id: string;
  title: string;
  folderPath?: string;
  updatedAt?: number;
  snippet?: string;
  matchType: 'title' | 'content';
}

/** A doc as the API returns it (A§6): timestamps in epoch ms, and the caller's role where the API says it. */
export interface ApiDoc {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  role?: string;
  folderPath?: string;
  surfaced?: boolean;
  /** The projected `<slug>.md` (A§5.1); wiki links resolve against its stem (A§15). */
  filename?: string;
  /** The owner's trashed notes only (A§11), in epoch ms. */
  trashedAt?: number | null;
}

/** Host-only controller, kept outside the ElectronAPI namespace inventory. */
export const WORKSPACE = Symbol('workspace');

export interface Vault { id: string; name: string; role?: string; owned?: boolean }
export interface WorkspaceFolder { id: string; name: string; path: string; surfaced: boolean; createdAt: number; noteCount: number; role?: string }
/** `GET /api/workspace`: the active vault and its docs. */
export interface WorkspaceListing {
  vault: Vault;
  vaults?: Vault[];
  folders?: WorkspaceFolder[];
  docs: ApiDoc[];
}

/** The browser behind the bridge; injected in unit tests. */
export interface BrowserHooks {
  origin: string;
  open(url: string): void;
  replacePath(path: string): void;
  onPopState(listener: () => void): () => void;
  copy(text: string, html: string): Promise<void>;
  /** The file chooser behind "/media → From computer"; `[]` when dismissed. */
  chooseFiles(accept: string): Promise<File[]>;
}

export interface BridgeOptions {
  /** The current path; `/d/$docId` names moss's window-context startup note, `/f/$folderId` the folder to reveal (A§4.2). */
  pathname: () => string;
  /** The share token this tab was opened with (`?share=`), threaded through every read (A§18). */
  share?: () => string | null;
  subscribeWorkspace?: (receive: (event: WorkspaceEvent) => void, pause: () => void) => () => void;
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  browser?: BrowserHooks;
  /** Closes docs to writes and waits for their acks before a trash (A§10.6); boot.tsx wires the doc sessions in. */
  trashGuard?: TrashGuard;
  /** The page's current leave: `signal` aborts as the page starts to leave, and `stayed` resolves if it is still
   * running afterwards (a cancelled navigation), so workspace reads are held, never cancelled by a navigation. */
  leaving?: () => Leave;
}

export interface Leave { signal: AbortSignal; stayed: Promise<void> }

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
const VAULT_KEY = 'moss-multi:active-vault';
/** Notes whose backlinks this tab keeps current: the ones it opened most recently. */
const BACKLINK_WATCH = 4;
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

/** What moss shows when the server refused a folder change without saying why: always a sentence. */
const FOLDER_REFUSALS: Record<number, string> = {
  401: 'You’re signed out. Sign in again to change folders.',
  403: 'You don’t have permission to change this folder.',
  404: 'That folder is no longer available, or you don’t have access to it.',
  409: 'That change conflicts with the folders as they are now. Refresh and try again.',
};
const FOLDER_UNAVAILABLE = 'The server couldn’t change the folder right now. Try again.';
const FOLDER_GONE = 'That folder is no longer here. It may have been moved or sent to Trash.';
const NOTE_REFUSALS: Record<number, string> = {
  401: 'You’re signed out. Sign in again to change this note.',
  403: 'Only the note’s owner can do that.',
  404: 'That note is no longer available, or you don’t have access to it.',
};
const NOTE_UNAVAILABLE = 'The server couldn’t change the note right now. Try again.';
const UNREACHABLE = 'The server couldn’t be reached. Check your connection and try again.';
/** A trash whose DocDO did not close answers 503; the owner's retry closes it (A§5.1 trash). */
const TRASH_ATTEMPTS = 3;
const TRASH_RETRY_MS = 500;
const openGuard: TrashGuard = { prepare: async () => true, release: () => undefined };

/** The server's own sentence for a refused change, else one chosen by status; moss renders `error.message` as is. */
async function refusalOf(response: Response, fallbacks = FOLDER_REFUSALS, unavailable = FOLDER_UNAVAILABLE): Promise<Error> {
  let message = '';
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') message = body.message.trim();
  } catch { /* not JSON: fall back below */ }
  return new Error(message || fallbacks[response.status] || unavailable);
}

export function docIdFromPath(pathname: string): string | null {
  const match = /^\/d\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function folderIdFromPath(pathname: string): string | null {
  const match = /^\/f\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function toNoteMetadata(doc: ApiDoc): NoteMetadata {
  return {
    id: doc.id,
    title: doc.title.trim() ? doc.title : UNTITLED,
    createdAt: seconds(doc.createdAt),
    updatedAt: seconds(doc.updatedAt),
    folderPath: doc.folderPath ?? ROOT_FOLDER,
    lastOpenedAt: null,
    trashedAt: doc.trashedAt != null ? seconds(doc.trashedAt) : null,
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
  chooseFiles: async () => [],
};

export function createBridge({ pathname, share = () => null, fetch: fetcher = fetch.bind(globalThis), storage = null, browser = inertBrowser, subscribeWorkspace: subscribe, leaving, trashGuard = openGuard }: BridgeOptions) {
  /** Every API call carries the tab's share token, so a link holder reads and edits through the link (T2.4). */
  const request = (path: string, init: RequestInit = {}) => {
    const token = share();
    return fetcher(path, { credentials: 'same-origin', ...init,
      headers: { accept: 'application/json', ...(token ? { 'x-moss-share': token } : {}), ...init.headers } });
  };
  /** WebKit logs a fetch cancelled by navigation as an access-control page error, so a workspace read in flight (its
   * body included) is aborted as the page leaves and held; if the page stays (the navigation was cancelled), it is
   * sent again. */
  const listingRequest = async (path: string): Promise<WorkspaceListing> => {
    for (;;) {
      const leave = leaving?.();
      if (leave?.signal.aborted) {
        await leave.stayed;
        continue;
      }
      try {
        const response = await request(path, leave ? { signal: leave.signal } : {});
        if (!response.ok) throw new Error(`GET /api/workspace: ${response.status}`);
        return (await response.json()) as WorkspaceListing;
      } catch (error) {
        if (!leave?.signal.aborted) throw error;
        await leave.stayed;
      }
    }
  };
  /** A path in this tab keeps its share token, so a reload or a reconnect still presents it. */
  const withShare = (path: string) => {
    const token = share();
    return token ? `${path}?share=${encodeURIComponent(token)}` : path;
  };

  // Every doc this tab has seen, from the listing or from a create; the listing promise is the boot read.
  const known = new Map<string, NoteMetadata>();
  let listing: Promise<NoteMetadata[]> | null = null;
  let workspaceSnapshot: WorkspaceListing | null = null;
  const workspaceListeners = new Set<() => void>();
  const diskListeners = new Set<Listener<[string[], string[]]>>();
  let loadVersion = 0;
  let stopWorkspace: (() => void) | null = null;
  let channelGeneration = 0;
  let refreshing = false;
  let refreshRetry: ReturnType<typeof setTimeout> | null = null;
  const pauseWorkspace = () => {
    channelGeneration += 1;
    pendingIds.clear();
    refreshAll = false;
    if (refreshRetry) clearTimeout(refreshRetry);
    refreshRetry = null;
  };
  let refreshAll = false;
  const pendingIds = new Set<string>();
  const load = (vaultId: string | null, docId: string | null = null, folderId: string | null = null): Promise<NoteMetadata[]> => {
    const version = ++loadVersion;
    const query = new URLSearchParams();
    if (vaultId) query.set('vault', vaultId);
    if (docId) query.set('doc', docId);
    if (folderId) query.set('folder', folderId);
    const pending: Promise<NoteMetadata[]> = listingRequest(`/api/workspace${query.size ? `?${query}` : ''}`).then((data) => {
      if (version !== loadVersion) return listing ?? [];
      const vaultsChanged = JSON.stringify([workspaceSnapshot?.vault, workspaceSnapshot?.vaults]) !== JSON.stringify([data.vault, data.vaults]);
      workspaceSnapshot = data;
      try { storage?.setItem(VAULT_KEY, data.vault.id); } catch { /* An in-memory choice still works. */ }
      for (const row of data.docs) rememberRole(row.id, row.role);
      const docs = data.docs.map(toNoteMetadata);
      for (const doc of docs) known.set(doc.id, doc);
      if (vaultsChanged) workspaceListeners.forEach((listener) => listener());
      return docs;
    });
    listing = pending;
    void pending.catch(() => { if (listing === pending) listing = null; });
    return pending;
  };
  const storedVault = () => {
    try { return storage?.getItem(VAULT_KEY) ?? null; } catch { return null; }
  };
  const refreshForNavigation = async (id: string) => {
    await load(workspaceSnapshot?.vault.id ?? storedVault(), id);
    diskListeners.forEach((listener) => listener([], []));
  };
  const refreshWorkspace = async () => {
    if (refreshing || !workspaceSnapshot) return;
    if (refreshRetry) clearTimeout(refreshRetry);
    refreshRetry = null;
    refreshing = true;
    const generation = channelGeneration;
    try {
      while (generation === channelGeneration && (refreshAll || pendingIds.size)) {
        const ids = [...pendingIds];
        const full = refreshAll;
        pendingIds.clear();
        refreshAll = false;
        const version = loadVersion;
        const vault = workspaceSnapshot.vault.id;
        const query = new URLSearchParams({ vault });
        if (!full) for (const id of ids) query.append('ids', id);
        const data = await listingRequest(`/api/workspace?${query}`);
        if (generation !== channelGeneration) break;
        if (version !== loadVersion) {
          await listing?.catch(() => undefined);
          if (generation !== channelGeneration) break;
          refreshAll = true;
          continue;
        }
        const changedVaults = JSON.stringify([workspaceSnapshot.vault, workspaceSnapshot.vaults]) !== JSON.stringify([data.vault, data.vaults]);
        const removed: Set<string> = new Set(full ? workspaceSnapshot.docs.map((doc) => doc.id) : ids);
        const docs: ApiDoc[] = [...(full ? [] : workspaceSnapshot.docs.filter((doc) => !removed.has(doc.id))), ...data.docs]
          .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        workspaceSnapshot = { ...data, docs };
        for (const id of removed) known.delete(id);
        for (const doc of data.docs) { known.set(doc.id, toNoteMetadata(doc)); rememberRole(doc.id, doc.role); }
        listing = Promise.resolve(docs.map(toNoteMetadata));
        if (changedVaults) workspaceListeners.forEach((listener) => listener());
        diskListeners.forEach((listener) => listener(full ? [] : ids, []));
        rereadBacklinks();
      }
    } catch {
      if (generation === channelGeneration) {
        refreshAll = true;
        refreshRetry = setTimeout(() => { void refreshWorkspace(); }, 1000);
      }
    } finally {
      refreshing = false;
      if (generation !== channelGeneration && (refreshAll || pendingIds.size)) void refreshWorkspace();
    }
  };
  const requestWorkspaceRefresh = () => {
    const generation = channelGeneration;
    void (listing ?? notes()).then(() => {
      if (generation === channelGeneration) return refreshWorkspace();
    }).catch(() => {
      if (generation !== channelGeneration || refreshRetry) return;
      refreshRetry = setTimeout(() => {
        refreshRetry = null;
        requestWorkspaceRefresh();
      }, 1000);
    });
  };
  // Backlinks (A§15) for the notes this tab opened most recently, carried on their records as moss's incomingLinks
  // and re-read whenever the workspace channel says a doc changed (a DocDO announces a change to its links).
  const backlinks = new Map<string, NoteLink[]>();
  const watched: string[] = [];
  const readBacklinks = async (id: string) => {
    try {
      const response = await request(`/api/docs/${encodeURIComponent(id)}/backlinks`);
      if (!response.ok) {
        if (response.status === 404) unwatch(id);
        return;
      }
      const answer = await response.json() as { backlinks?: ApiDoc[] };
      if (!Array.isArray(answer.backlinks)) return;
      const links = answer.backlinks.map((row): NoteLink => {
        const live = liveTitle(row.id);
        return { noteId: row.id, title: live === null ? toNoteMetadata(row).title : displayTitle(live),
          folderPath: known.get(row.id)?.folderPath ?? ROOT_FOLDER, updatedAt: seconds(row.updatedAt) };
      });
      if (JSON.stringify(links) === JSON.stringify(backlinks.get(id) ?? [])) {
        if (!backlinks.has(id)) backlinks.set(id, links);
        return;
      }
      backlinks.set(id, links);
      // A metadata-only change: moss re-reads this note's record, which now carries the links.
      diskListeners.forEach((listener) => listener([id], []));
    } catch { /* The next workspace event or note switch reads them again. */ }
  };
  const unwatch = (id: string) => {
    const at = watched.indexOf(id);
    if (at !== -1) watched.splice(at, 1);
  };
  /** After the listing caught up with a workspace event: a watched note that left it (trashed, unshared) is dropped. */
  const rereadBacklinks = () => {
    for (const id of [...watched]) {
      if (inListing(id)) void readBacklinks(id);
      else unwatch(id);
    }
  };
  // Only live listed notes: moss records links for them, and a trashed or unshared one would 404.
  const inListing = (id: string) => workspaceSnapshot?.docs.some((doc) => doc.id === id && doc.trashedAt == null) ?? false;
  const watchBacklinks = (id: string) => {
    if (!inListing(id)) return;
    const at = watched.indexOf(id);
    if (at !== -1) watched.splice(at, 1);
    watched.unshift(id);
    watched.splice(BACKLINK_WATCH);
    void readBacklinks(id);
  };
  const receiveWorkspace = (event: WorkspaceEvent) => {
    if (event.type !== 'meta' && event.type !== 'vaults') return;
    if (event.type === 'vaults' || event.folderIds.length) refreshAll = true;
    if (event.type === 'meta') for (const id of event.docIds) pendingIds.add(id);
    requestWorkspaceRefresh();
  };
  const pins = () => readJson<Record<string, number>>(storage, PINS_KEY) ?? {};
  const withLocal = (listed: NoteMetadata): NoteMetadata => {
    // A doc this tab binds is named by its live Y.Text title, never by a listing read before a rename (A§9).
    const live = liveTitle(listed.id);
    let note = live === null ? listed : { ...listed, title: displayTitle(live) };
    const links = backlinks.get(note.id);
    if (links) note = { ...note, incomingLinks: links };
    const pinnedAt = pins()[note.id];
    return pinnedAt ? { ...note, pinned: true, pinnedAt } : note;
  };
  /** moss's notes:search: title matches over the listing first, then the index's hits across every doc the caller can discover. */
  const search = async ({ query, limit = 20, excludeNoteId, searchTrashed }: { query: string; limit?: number; excludeNoteId?: string; searchTrashed?: boolean }) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    if (searchTrashed) {
      // The Trash view searches only the owner's trashed notes, by title; the index holds live docs.
      return (await notes())
        .filter((note) => note.trashedAt != null && note.title.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((note) => ({ id: note.id, title: note.title, folderPath: note.folderPath, updatedAt: note.updatedAt, matchType: 'title' as const }));
    }
    const listed = (await notes()).filter((note) => note.id !== excludeNoteId && note.trashedAt == null);
    const rank = (title: string) => (title === needle ? 0 : title.startsWith(needle) ? 1 : 2);
    const titled: NoteSearchResult[] = listed
      .filter((note) => note.title.toLowerCase().includes(needle))
      .sort((a, b) => rank(a.title.toLowerCase()) - rank(b.title.toLowerCase()) || b.updatedAt - a.updatedAt)
      .map((note) => ({ id: note.id, title: note.title, folderPath: note.folderPath, updatedAt: note.updatedAt, matchType: 'title' }));
    if (searchTrashed) return titled.slice(0, limit);
    const response = await request(`/api/search?${new URLSearchParams({ q: query.trim(), limit: String(limit) })}`);
    if (!response.ok) throw new Error(`GET /api/search: ${response.status}`);
    const { results } = await response.json() as { results: (ApiDoc & { snippet: string })[] };
    const seen = new Set(titled.map((hit) => hit.id));
    const indexed: NoteSearchResult[] = results.filter((hit) => hit.id !== excludeNoteId && !seen.has(hit.id)).map((hit) => {
      const listedNote = listed.find((note) => note.id === hit.id);
      const title = listedNote?.title ?? toNoteMetadata(hit).title;
      return { id: hit.id, title, folderPath: listedNote?.folderPath ?? ROOT_FOLDER, updatedAt: listedNote?.updatedAt ?? seconds(hit.updatedAt),
        ...(title.toLowerCase().includes(needle) ? { matchType: 'title' as const } : { snippet: hit.snippet, matchType: 'content' as const }) };
    });
    return [...titled, ...indexed].slice(0, limit);
  };
  const notes = () => {
    const first = !workspaceSnapshot;
    return (listing ?? load(workspaceSnapshot?.vault.id ?? storedVault(), first ? docIdFromPath(pathname()) : null, first ? folderIdFromPath(pathname()) : null))
      .then((docs) => docs.map(withLocal));
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
  const docUrl = (id: string) => new URL(withShare(`/d/${encodeURIComponent(id)}`), browser.origin).href;

  // Folders (A§9): moss names a folder by its `Notes/...` path; the refreshed id↔path map turns it into a server id.
  const idForPath = (path: string): string | null => {
    if (!workspaceSnapshot) return null;
    if (path === ROOT_FOLDER) return workspaceSnapshot.vault.id;
    return workspaceSnapshot.folders?.find((folder) => folder.path === path)?.id ?? null;
  };
  /** The id for a path, re-reading the listing once if this tab's map is behind; a vanished folder is a sentence. */
  const folderId = async (path: string | undefined): Promise<string> => {
    const target = path || ROOT_FOLDER;
    if (!workspaceSnapshot) await notes();
    let id = idForPath(target);
    if (!id) {
      await load(workspaceSnapshot?.vault.id ?? storedVault());
      id = idForPath(target);
    }
    if (!id) throw new Error(FOLDER_GONE);
    return id;
  };
  /** A folder change: the request, a sentence on refusal, then the fresh listing that moss reads back. */
  const changeFolders = async (path: string, init: { method: string; json?: unknown }): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(path, {
        method: init.method,
        ...(init.json === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.json) }),
      });
    } catch {
      throw new Error('The server couldn’t be reached. Check your connection and try again.');
    }
    if (!response.ok) throw await refusalOf(response);
    const answer: unknown = await response.json().catch(() => ({}));
    await load(workspaceSnapshot?.vault.id ?? storedVault()).catch(() => undefined);
    return answer;
  };
  /** Notes and folders re-read after a folder change, as a disk change does on the desktop. */
  const announceFolders = () => diskListeners.forEach((listener) => listener([], []));
  const folderEntry = (folder: WorkspaceFolder) => ({ name: folder.name, path: folder.path, noteCount: folder.noteCount, createdAt: seconds(folder.createdAt) });
  const entryFor = (id: string, fallback: { name: string; path: string }) => {
    const folder = workspaceSnapshot?.folders?.find((candidate) => candidate.id === id);
    return folder ? folderEntry(folder) : { ...fallback, noteCount: 0, createdAt: seconds(Date.now()) };
  };
  /** The trash DELETE, repeated while a DocDO has not closed (503); a refusal is the server's sentence. */
  const sendTrash = async (path: string, fallbacks: Record<number, string>, unavailable: string): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await request(path, { method: 'DELETE' });
      } catch {
        throw new Error(UNREACHABLE);
      }
      if (response.ok) return;
      if (response.status !== 503 || attempt >= TRASH_ATTEMPTS) throw await refusalOf(response, fallbacks, unavailable);
      await new Promise((resolve) => setTimeout(resolve, TRASH_RETRY_MS));
    }
  };
  /** Notes in a folder's subtree that this tab may hold open. */
  const notesUnder = (path: string) => (workspaceSnapshot?.docs ?? [])
    .filter((doc) => doc.trashedAt == null && (doc.folderPath === path || doc.folderPath?.startsWith(`${path}/`)))
    .map((doc) => doc.id);
  const moveNotes = async (noteIds: string[], targetFolderPath: string) => {
    const target = await folderId(targetFolderPath);
    for (const id of noteIds) await changeFolders(`/api/docs/${encodeURIComponent(id)}`, { method: 'PATCH', json: { folderId: target } });
    return noteIds.flatMap((id) => {
      const note = known.get(id);
      return note ? [record(withLocal(note))] : [];
    });
  };

  return {
    [WORKSPACE]: {
      duplicate: async (id: string) => {
        const response = await request(`/api/docs/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
        if (!response.ok) throw new Error(`Duplicate: ${response.status}`);
        const result = await response.json() as { doc: ApiDoc; role: string };
        rememberRole(result.doc.id, result.role);
        const note = toNoteMetadata(result.doc);
        known.set(note.id, note);
        listing = null;
        return { ...record(note), content: '' };
      },
      getSnapshot: () => workspaceSnapshot,
      subscribe: (listener: () => void) => {
        workspaceListeners.add(listener);
        return () => { workspaceListeners.delete(listener); };
      },
      switchVault: async (id: string) => {
        await load(id);
        diskListeners.forEach((listener) => listener([], []));
      },
      /** The owner trashed this note, as far as this tab knows. */
      isTrashed: (id: string) => known.get(id)?.trashedAt != null,
      surfacedShared: (id: string) => workspaceSnapshot?.docs.some((doc) => doc.id === id && doc.surfaced) ?? false,
      surfacedFolder: (path: string) => workspaceSnapshot?.folders?.some((folder) => folder.surfaced &&
        (path === folder.path || path.startsWith(`${folder.path}/`))) ?? false,
      /** The listed folder at a moss path, with the caller's role on it. */
      folderAt: (path: string) => workspaceSnapshot?.folders?.find((folder) => folder.path === path) ?? null,
      /** The listed folder with this id; the active vault itself is `Notes`. */
      folderById: (id: string) => (workspaceSnapshot?.vault.id === id
        ? { id, name: workspaceSnapshot.vault.name, path: ROOT_FOLDER }
        : workspaceSnapshot?.folders?.find((folder) => folder.id === id) ?? null),
      /** The caller's role on a sidebar folder (`Notes` is the active vault), or null for a path the map lacks. */
      folderRole: (path: string): string | null => {
        if (!workspaceSnapshot) return null;
        if (path === ROOT_FOLDER) return workspaceSnapshot.vault.role ?? null;
        return workspaceSnapshot.folders?.find((folder) => folder.path === path)?.role ?? null;
      },
    },
    notes: {
      getAll: () => notes(),
      getMetadataByIds: async (ids: string[]) => (await notes()).filter((note) => ids.includes(note.id)),
      getById: async (id: string) => {
        const note = await byId(id);
        if (note && note.trashedAt == null) watchBacklinks(id);
        if (note?.trashedAt != null) {
          // The owner's Trash view reads a trashed note on its one read path, read-only (A§8).
          const response = await request(`/api/trash/${encodeURIComponent(id)}`);
          if (!response.ok) return undefined;
          const { markdown } = (await response.json()) as { markdown: string };
          return { ...record(note), content: markdown };
        }
        // A doc that will bind gets no content from REST: the binding fills it (A§9).
        return note ? { ...record(note), content: '', layoutMetadata: readJson(storage, layoutKey(id)) } : undefined;
      },
      getContent: async (id: string) => ((await byId(id)) ? { id, content: '', version: 1 } : undefined),
      getFrontmatterSuggestions: async () => ({}),
      getHeadings: async (id: string) => {
        const response = await request(`/api/docs/${encodeURIComponent(id)}/headings`);
        if (!response.ok) return [];
        const { headings } = await response.json() as { headings?: { level: 1 | 2 | 3 | 4; text: string }[] };
        return Array.isArray(headings) ? headings : [];
      },
      create: async (title: string, folderPath: string = ROOT_FOLDER) => {
        // moss creates in the active folder; before the first listing the server picks the caller's Home.
        const target = folderPath !== ROOT_FOLDER || workspaceSnapshot ? await folderId(folderPath) : null;
        // "Untitled" is moss's placeholder name; the doc's title starts empty (A§5.1).
        const body = { ...(title.trim() && title.trim() !== UNTITLED ? { title: title.trim() } : {}),
          ...(target ? { folderId: target } : {}) };
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
      // Trash (A§10.6): closed to writes and acked first, then the owner's DELETE; moss marks the note trashed.
      delete: async (id: string) => {
        const ready = await trashGuard.prepare([id]);
        let trashed = false;
        try {
          if (!ready) return false;
          await sendTrash(`/api/docs/${encodeURIComponent(id)}`, NOTE_REFUSALS, NOTE_UNAVAILABLE);
          trashed = true;
        } finally {
          trashGuard.release([id], trashed);
        }
        const note = known.get(id);
        if (note) known.set(id, { ...note, trashedAt: seconds(Date.now()) });
        await load(workspaceSnapshot?.vault.id ?? storedVault()).catch(() => undefined);
        return true;
      },
      restore: async (id: string) => {
        let response: Response;
        try {
          response = await request(`/api/docs/${encodeURIComponent(id)}/restore`, { method: 'POST' });
        } catch {
          throw new Error(UNREACHABLE);
        }
        if (!response.ok) throw await refusalOf(response, NOTE_REFUSALS, NOTE_UNAVAILABLE);
        // Live at once: a listing that lands later, or a refresh that supersedes this one, must not reopen the Trash view.
        const restored = () => {
          const note = known.get(id);
          if (note?.trashedAt != null) known.set(id, { ...note, trashedAt: null });
          return known.get(id);
        };
        restored();
        await load(workspaceSnapshot?.vault.id ?? storedVault()).catch(() => undefined);
        const note = restored();
        return note ? record(withLocal(note)) : undefined;
      },
      search,
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
          if (id && callback) {
            void refreshForNavigation(id);
            callback(id);
          }
        }),
      onDiskChange: (callback?: Listener<[string[], string[]]>) => {
        if (callback) diskListeners.add(callback);
        if (!stopWorkspace && diskListeners.size && subscribe) stopWorkspace = subscribe(receiveWorkspace, pauseWorkspace);
        return () => {
          if (callback) diskListeners.delete(callback);
          if (!diskListeners.size) {
            stopWorkspace?.();
            stopWorkspace = null;
            pauseWorkspace();
          }
        };
      },
      onMetadataReindexed: silent,
      onRequestFlush: silent,
      flushComplete: none,
    },
    folders: {
      list: async () => {
        await notes();
        return (workspaceSnapshot?.folders ?? []).map((folder) => ({ ...folder, createdAt: seconds(folder.createdAt) }));
      },
      create: async ({ name, parentPath, noteIds = [] }: { name: string; parentPath?: string; noteIds?: string[] }) => {
        const parentId = await folderId(parentPath);
        const answer = await changeFolders('/api/folders', { method: 'POST', json: { parentId, name } }) as { folder?: { id: string; name: string } };
        const created = answer.folder?.name ?? name;
        const entry = entryFor(answer.folder?.id ?? '', { name: created, path: `${parentPath || ROOT_FOLDER}/${created}` });
        if (noteIds.length) await moveNotes(noteIds, entry.path);
        announceFolders();
        return entry;
      },
      rename: async ({ currentPath, newName }: { currentPath: string; newName: string }) => {
        const id = await folderId(currentPath);
        const answer = await changeFolders(`/api/folders/${encodeURIComponent(id)}`, { method: 'PATCH', json: { name: newName } }) as { folder?: { name: string } };
        announceFolders();
        const renamed = answer.folder?.name ?? newName;
        return entryFor(id, { name: renamed, path: `${currentPath.split('/').slice(0, -1).join('/')}/${renamed}` });
      },
      // moss's one caller trashes the subtree; the server keeps it as one batch for restore (A§6). Its open notes
      // close to writes and ack first, as a note's trash does (A§10.6).
      delete: async ({ path }: { path: string; moveNotesTo?: 'root' | 'trash' }) => {
        const id = await folderId(path);
        const open = notesUnder(path);
        const ready = await trashGuard.prepare(open);
        let trashed = false;
        try {
          if (!ready) return false;
          await sendTrash(`/api/folders/${encodeURIComponent(id)}`, FOLDER_REFUSALS, FOLDER_UNAVAILABLE);
          trashed = true;
        } finally {
          trashGuard.release(open, trashed);
        }
        await load(workspaceSnapshot?.vault.id ?? storedVault()).catch(() => undefined);
        announceFolders();
        return true;
      },
      moveNotes: async ({ noteIds, targetFolderPath }: { noteIds: string[]; targetFolderPath: string }) => {
        const moved = await moveNotes(noteIds, targetFolderPath);
        announceFolders();
        return moved;
      },
      moveFolder: async ({ sourcePath, targetParentPath }: { sourcePath: string; targetParentPath: string }) => {
        const id = await folderId(sourcePath);
        const parentId = await folderId(targetParentPath);
        await changeFolders(`/api/folders/${encodeURIComponent(id)}`, { method: 'PATCH', json: { parentId } });
        announceFolders();
        const name = sourcePath.split('/').pop() ?? '';
        return entryFor(id, { name, path: `${targetParentPath}/${name}` });
      },
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
      ...createImagesApi({ request, chooseFiles: (accept) => browser.chooseFiles(accept) }),
      persistUrl: later('Saving a remote image', 3),
      copyFromPath: unavailable('Copying a local file'),
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
      // The image context menu offers Edit Alt Text… on any image in an editable note (deviation 5; ImageContextMenu).
      setImageAltTextMenuEnabled: none,
      // Open in New Window is a browser tab (R4).
      createWindow: async (input: { noteId?: string | null } = {}) => {
        browser.open(input.noteId ? docUrl(input.noteId) : new URL('/', browser.origin).href);
        return { action: 'created' as const, windowId: -1 };
      },
      getWindowContext: async () => ({ windowId: 1, initialNoteId: docIdFromPath(pathname()), launchReason: 'initial-launch' as const, openedFromWindowId: null }),
      // The address follows the focused note, so a reload or a copied URL reopens it (A§4.2).
      setFocusedNoteId: async (id: string | null) => {
        if (id && known.get(id)?.trashedAt == null) watchBacklinks(id);
        // A trashed note has no address: a fresh load of it is the one 404 (A§8).
        if (id && known.get(id)?.trashedAt == null && docIdFromPath(pathname()) !== id) {
          browser.replacePath(withShare(`/d/${encodeURIComponent(id)}`));
          await refreshForNavigation(id);
        }
      },
      startWindowDrag: none,
      moveWindowDrag: none,
      endWindowDrag: none,
      onGlobalShortcutActivated: silent,
      onNativeMenuCommand,
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
let installedBridge: Bridge | null = null;
export const getBridge = () => installedBridge;

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
    chooseFiles: chooseFilesInBrowser,
  };
}

/** A page still running this long after `beforeunload` stayed: its navigation was cancelled (a prompt, a download). */
const STAYED_MS = 5_000;

/** Aborts on `beforeunload`, before WebKit stops the page's loads for the navigation. The leave ends, releasing the
 * held reads, when the page is still here after STAYED_MS or comes back from the back-forward cache. */
function leavingSignal(): () => Leave {
  const arm = () => {
    let end = () => undefined as void;
    const stayed = new Promise<void>((resolve) => { end = resolve; });
    return { controller: new AbortController(), stayed, end };
  };
  let current = arm();
  const stay = () => {
    if (!current.controller.signal.aborted) return;
    const left = current;
    current = arm();
    left.end();
  };
  window.addEventListener('beforeunload', () => {
    current.controller.abort();
    setTimeout(stay, STAYED_MS);
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) stay(); });
  return () => ({ signal: current.controller.signal, stayed: current.stayed });
}

/** Installs the bridge on `window` before App's module evaluates (A§4.3). */
export function installBridge(authStore: import('../auth-state.ts').AuthStore, trashGuard?: TrashGuard): Bridge {
  const bridge = createBridge({ pathname: () => window.location.pathname, storage: localStorageOrNull(), browser: windowBrowser(), trashGuard,
    share: () => new URLSearchParams(window.location.search).get('share'),
    leaving: leavingSignal(),
    subscribeWorkspace: (receive, pause) => subscribeWorkspace({
      onPause: pause,
      auth: authStore,
      socket: () => new WebSocket(`${window.location.origin.replace(/^http/, 'ws')}/api/workspace/ws`),
      visible: () => document.visibilityState === 'visible',
      onVisible: (callback) => {
        const visible = () => { if (document.visibilityState === 'visible') callback(); };
        document.addEventListener('visibilitychange', visible);
        window.addEventListener('online', visible);
        return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible); };
      },
    }, receive),
  });
  installedBridge = bridge;
  setWikiCandidates(() => bridge[WORKSPACE].getSnapshot()?.docs ?? []);
  (window as unknown as { electronAPI: Bridge }).electronAPI = bridge;
  return bridge;
}
