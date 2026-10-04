// ported-from: packages/desktop/src/renderer/state/granted-dirs-atoms.ts @ 762abb777
import { atom } from 'jotai';

import { type ActionPromptMention } from '@moss/shared/state/atoms';
import { grantedDirsApi, filesApi } from '../api/electron';

/** Granted directory paths */
export const grantedDirsAtom = atom<string[]>([]);

/** Write-only: refresh granted dirs list from main process */
export const refreshGrantedDirsAtom = atom(null, async (_get, set) => {
  try {
    const dirs = await grantedDirsApi.list.invoke();
    set(grantedDirsAtom, dirs);
    return dirs;
  } catch {
    // Non-critical — settings may not have granted any dirs yet
    return undefined;
  }
});

// ---------------------------------------------------------------------------
// Connected Folder Entries Cache — top-level files/dirs per connected folder
// ---------------------------------------------------------------------------

export interface ConnectedFolderEntry {
  name: string;
  path: string;
  isDir: boolean;
}

const MAX_ENTRIES_PER_FOLDER = 1000;

const sameDirs = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((dir, index) => dir === b[index]);

/** Cached top-level entries for each connected folder. Key = folder path. */
export const connectedFolderEntriesAtom = atom<Map<string, ConnectedFolderEntry[]>>(new Map());

/** Write-only: refresh cached entries for all connected folders.
 *  Reads current grantedDirsAtom, fetches top-level listing for each,
 *  and replaces the cache only if the granted-dir snapshot is still current.
 */
export const refreshConnectedFolderEntriesAtom = atom(null, async (get, set) => {
  const dirs = get(grantedDirsAtom);
  if (dirs.length === 0) {
    set(connectedFolderEntriesAtom, new Map());
    return;
  }

  const results = await Promise.all(
    dirs.map(async (dirPath) => {
      try {
        const entries = await filesApi.listDirectory.invoke({ dirPath });
        const mapped: ConnectedFolderEntry[] = entries
          .slice(0, MAX_ENTRIES_PER_FOLDER)
          .map((e) => ({
            name: e.title,
            path: e.path,
            isDir: e.type === 'directory'
          }));
        return [dirPath, mapped] as const;
      } catch {
        return [dirPath, [] as ConnectedFolderEntry[]] as const;
      }
    })
  );

  if (!sameDirs(get(grantedDirsAtom), dirs)) {
    return;
  }

  set(connectedFolderEntriesAtom, new Map(results));
});

/**
 * Write-only: grant a new directory via the native picker and wire up the
 * renderer state so the newly granted folder is available for @mentions.
 *
 * Runs: grant → update `grantedDirsAtom` immediately, then refresh connected-
 * folder entries in the background. Returns the updated granted-dirs list from
 * IPC.
 *
 * Shared by connected-folder entry points. External note imports should use
 * `files.open` instead so the imported note records flow back to the sidebar.
 */
export const grantNewDirectoryAtom = atom(
  null,
  async (
    get,
    set,
    input?: Parameters<typeof grantedDirsApi.grant.invoke>[0]
  ): Promise<string[] | undefined> => {
    const previousDirs = get(grantedDirsAtom);
    const dirs = await grantedDirsApi.grant.invoke(input);
    const dirsUnchanged = sameDirs(dirs, previousDirs);

    if (!dirsUnchanged) {
      set(grantedDirsAtom, dirs);
    }

    void (async () => {
      try {
        await set(refreshConnectedFolderEntriesAtom);
      } catch {
        // Non-critical — file search can refresh on the next mention open.
      }
    })();
    return dirs;
  }
);

/** Write-only: revoke a granted directory and update the live atom source. */
export const revokeGrantedDirectoryAtom = atom(
  null,
  async (_get, set, dirPath: string): Promise<string[]> => {
    const dirs = await grantedDirsApi.revoke.invoke(dirPath);
    set(grantedDirsAtom, dirs);
    void (async () => {
      try {
        await set(refreshConnectedFolderEntriesAtom);
      } catch {
        // Non-critical — file search can refresh on the next mention open.
      }
    })();
    return dirs;
  }
);

// ---------------------------------------------------------------------------
// Context Pills — persistent across command palette open/close
// ---------------------------------------------------------------------------

/** Whether the user has ever submitted an action (persisted across restarts).
 *  Connected folders only seed pills before the very first action ever.
 */
const HAS_SUBMITTED_KEY = 'moss:hasSubmittedAction';
const LAST_SUBMITTED_MENTION_PILLS_KEY = 'moss:lastSubmittedActionMentions';

const getStorageItem = (key: string): string | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
};

const setStorageItem = (key: string, value: string): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // Best-effort persistence only; in-memory atoms still update.
  }
};

const isActionPromptMentionType = (value: unknown): value is ActionPromptMention['type'] =>
  value === 'note' || value === 'directory' || value === 'folder';

const normalizeMentionPills = (value: unknown): ActionPromptMention[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const mentionsByKey = new Map<string, ActionPromptMention>();
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const type = record.type;
    if (!id || !title || !isActionPromptMentionType(type)) {
      continue;
    }

    const mention: ActionPromptMention = { id, title, type };
    if (
      typeof record.fileCount === 'number' &&
      Number.isFinite(record.fileCount) &&
      record.fileCount >= 0
    ) {
      mention.fileCount = record.fileCount;
    }

    mentionsByKey.set(`${type}:${id}`, mention);
  }

  return Array.from(mentionsByKey.values());
};

const readHasSubmitted = (): boolean => getStorageItem(HAS_SUBMITTED_KEY) === '1';

const readLastSubmittedMentionPills = (): ActionPromptMention[] => {
  const stored = getStorageItem(LAST_SUBMITTED_MENTION_PILLS_KEY);
  if (!stored) {
    return [];
  }

  try {
    return normalizeMentionPills(JSON.parse(stored));
  } catch {
    return [];
  }
};

const persistLastSubmittedMentionPills = (pills: ActionPromptMention[]): void => {
  setStorageItem(LAST_SUBMITTED_MENTION_PILLS_KEY, JSON.stringify(pills));
};

const hasSubmittedValueAtom = atom<boolean | null>(null);
const hasSubmittedAtom = atom(
  (get) => get(hasSubmittedValueAtom) ?? readHasSubmitted(),
  (_get, set, value: boolean) => {
    set(hasSubmittedValueAtom, value);
  }
);

/** IDs dismissed by the user this session. */
const contextPillsDismissedAtom = atom<Set<string>>(new Set<string>());

/** @mentions from the last submitted action. Replaces on each submit. */
const contextPillsMentionsValueAtom = atom<ActionPromptMention[] | null>(null);
const contextPillsMentionsAtom = atom(
  (get) => get(contextPillsMentionsValueAtom) ?? readLastSubmittedMentionPills(),
  (_get, set, pills: ActionPromptMention[]) => {
    set(contextPillsMentionsValueAtom, pills);
  }
);

/** Derived read-only pills.
 *  - Before first action: connected folders from Settings (minus dismissed)
 *  - After first action: last action's @mentions (minus dismissed)
 */
export const contextPillsAtom = atom((get) => {
  const dismissed = get(contextPillsDismissedAtom);
  const hasSubmitted = get(hasSubmittedAtom);

  if (!hasSubmitted) {
    // Initial seed: connected folders from Settings
    const entriesCache = get(connectedFolderEntriesAtom);
    return get(grantedDirsAtom)
      .map(path => ({
        id: path,
        title: path.split('/').pop() || path,
        type: 'directory' as const,
        fileCount: entriesCache.get(path)?.length ?? 1
      }))
      .filter(p => !dismissed.has(p.id));
  }

  // After first action: last action's @mentions only
  return get(contextPillsMentionsAtom).filter(p => !dismissed.has(p.id));
});

/** Dismiss a pill by ID. */
export const dismissPillAtom = atom(null, (_get, set, id: string) => {
  set(contextPillsDismissedAtom, (prev: Set<string>) => new Set([...prev, id]));
});

/** Replace pills with @mentions from the latest action submission. */
export const setMentionPillsAtom = atom(null, (_get, set, pills: ActionPromptMention[]) => {
  const normalizedPills = normalizeMentionPills(pills);
  set(hasSubmittedAtom, true);
  setStorageItem(HAS_SUBMITTED_KEY, '1');
  persistLastSubmittedMentionPills(normalizedPills);
  set(contextPillsMentionsAtom, normalizedPills);
  set(contextPillsDismissedAtom, new Set<string>()); // clear dismissals — new pill set
});
