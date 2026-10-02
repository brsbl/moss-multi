// ported-from: packages/desktop/src/renderer/editor/typeahead/mentionSearch.ts @ 762abb777
/**
 * Shared @-mention search logic used by prompt inputs. Connected-folder
 * candidates are supplied as an explicit renderer snapshot; filesystem
 * drilling still goes through IPC.
 */
import type { useStore } from 'jotai';
import { FileText, Folder, FolderOpen } from 'lucide-react';

import { backendFoldersAtom } from '@moss/shared/state/atoms';
import { noteEntityAtom, noteIdsAtom } from '@moss/shared/state/note-atoms';

import { filesApi } from '../../api/electron';
import type { ConnectedFolderEntry } from '../../state/granted-dirs-atoms';
import type { TypeaheadItem } from './types';

type JotaiStore = ReturnType<typeof useStore>;

export interface MentionSearchSnapshot {
  grantedDirs: string[];
  connectedFolderEntries: Map<string, ConnectedFolderEntry[]>;
}

/** Extract the last segment of a folder path for display (e.g. "Notes/Projects" -> "Projects") */
const folderDisplayName = (fp?: string): string => {
  if (!fp || fp === 'Notes') return 'Notes';
  const parts = fp.split('/');
  return parts[parts.length - 1] || 'Notes';
};

const normalizeSearchText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/^notes\//, '')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const matchesQuery = (query: string, values: Array<string | undefined>): boolean => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  return values.some((value) =>
    value ? normalizeSearchText(value).includes(normalizedQuery) : false
  );
};

const addFolderPathCandidates = (folderPath: string | undefined, target: Set<string>): void => {
  const normalizedPath = folderPath || 'Notes';
  if (normalizedPath === 'Notes') {
    target.add('Notes');
    return;
  }

  const segments = normalizedPath.split('/').filter(Boolean);
  const startIndex = segments[0] === 'Notes' ? 2 : 1;
  for (let segmentCount = startIndex; segmentCount <= segments.length; segmentCount += 1) {
    const candidatePath = segments.slice(0, segmentCount).join('/');
    if (candidatePath) {
      target.add(candidatePath);
    }
  }
};

/**
 * Search for @-mention candidates. Synchronous for top-level and Moss folder
 * drilling; async only when drilling into an external directory (IPC).
 */
export function mentionSearch(
  query: string,
  store: JotaiStore,
  snapshot: MentionSearchSnapshot
): TypeaheadItem[] | Promise<TypeaheadItem[]> {
  const slashIndex = query.indexOf('/');
  const isDrilling = slashIndex >= 0;

  if (isDrilling) {
    return handleDrillSearch(query, store, snapshot);
  }

  return handleTopLevelSearch(query, store, snapshot);
}

// ── Top-level search (no slash) ──────────────────────────────────────

function handleTopLevelSearch(
  query: string,
  store: JotaiStore,
  snapshot: MentionSearchSnapshot
): TypeaheadItem[] {
  const lowerQuery = query.toLowerCase();

  // -- Granted directories section --
  const grantedDirs = snapshot.grantedDirs;
  const dirItems: TypeaheadItem[] = [];

  for (const dirPath of grantedDirs) {
    const dirName = dirPath.split('/').filter(Boolean).pop() || dirPath;
    const shortPath = dirPath.replace(/^\/Users\/[^/]+/, '~');

    if (!matchesQuery(lowerQuery, [dirName, shortPath])) {
      continue;
    }

    dirItems.push({
      id: dirPath,
      label: dirName,
      description: shortPath,
      icon: FolderOpen,
      category: 'Connected Folders',
      data: 'directory'
    });
  }

  // -- Connected folder entries (files/subdirs from cache) --
  // Tagged as 'connected-subdir'/'connected-file' to distinguish from
  // connected folder roots ('directory') — they need different drill paths.
  if (lowerQuery) {
    const entriesCache = snapshot.connectedFolderEntries;
    for (const [folderPath, entries] of entriesCache) {
      const rootName = folderPath.split('/').filter(Boolean).pop() || folderPath;
      for (const entry of entries) {
        if (!matchesQuery(lowerQuery, [entry.name])) continue;
        const shortPath = entry.path.replace(/^\/Users\/[^/]+/, '~');
        dirItems.push({
          id: entry.path,
          label: entry.name,
          description: shortPath,
          icon: entry.isDir ? FolderOpen : FileText,
          category: 'Connected Folders',
          data: entry.isDir ? `connected-subdir:${rootName}` : 'connected-file'
        });
      }
    }
  }

  // -- Notes + folders section --
  const noteIds = store.get(noteIdsAtom);
  const folderPathSet = new Set<string>();
  const candidateNotes: Array<{
    id: string;
    title: string;
    folderPath?: string;
  }> = [];

  for (const folder of store.get(backendFoldersAtom)) {
    addFolderPathCandidates(folder.path, folderPathSet);
  }

  // Collect external root paths from note entities (opened via File > Open)
  // that are NOT already in grantedDirsAtom (connected via Settings).
  const grantedDirNormalized = new Set(grantedDirs.map((d) => d.replace(/\/$/, '')));
  const seenRootPaths = new Set<string>();

  for (const noteId of noteIds) {
    const entity = store.get(noteEntityAtom(noteId));
    if (!entity || entity.trashedAt != null) continue;

    // Track external root paths for directory items
    if (entity.externalRootPath) {
      const normalized = entity.externalRootPath.replace(/\/$/, '');
      if (!grantedDirNormalized.has(normalized)) {
        seenRootPaths.add(normalized);
      }
    }

    const normalizedFolderPath = entity.folderPath || 'Notes';
    addFolderPathCandidates(normalizedFolderPath, folderPathSet);
    candidateNotes.push({
      id: entity.id,
      title: entity.title,
      folderPath: normalizedFolderPath
    });
  }

  // Add opened external root paths as directory items
  for (const dirPath of seenRootPaths) {
    const dirName = dirPath.split('/').filter(Boolean).pop() || dirPath;
    const shortPath = dirPath.replace(/^\/Users\/[^/]+/, '~');

    if (!matchesQuery(lowerQuery, [dirName, shortPath])) {
      continue;
    }

    dirItems.push({
      id: dirPath,
      label: dirName,
      description: shortPath,
      icon: FolderOpen,
      category: 'External',
      data: 'directory'
    });
  }

  const folderItems: TypeaheadItem[] = Array.from(folderPathSet)
    .map((folderPath) => {
      const label = folderDisplayName(folderPath);
      return {
        id: folderPath,
        label,
        description: undefined,
        icon: Folder,
        category: 'Moss Folders',
        data: 'folder'
      } as TypeaheadItem;
    })
    .filter((item) => {
      return matchesQuery(lowerQuery, [item.label, item.id]);
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const noteItems: TypeaheadItem[] = candidateNotes
    .filter((entity) => {
      return matchesQuery(lowerQuery, [entity.title]);
    })
    .map((entity) => ({
      id: entity.id,
      label: entity.title,
      description: folderDisplayName(entity.folderPath),
      icon: FileText,
      category: 'Notes',
      data: 'note'
    }));

  noteItems.sort((a, b) => a.label.localeCompare(b.label));

  return [...dirItems, ...folderItems, ...noteItems];
}

// ── Filesystem drill helper ───────────────────────────────────────────

/** Determine the category label for a filesystem path based on granted dirs. */
function resolveDirectoryCategory(targetPath: string, snapshot: MentionSearchSnapshot): string {
  const grantedDirs = snapshot.grantedDirs;
  const normalized = targetPath.replace(/\/$/, '');
  for (const grantedDir of grantedDirs) {
    const normalizedGranted = grantedDir.replace(/\/$/, '');
    if (normalized === normalizedGranted || normalized.startsWith(normalizedGranted + '/')) {
      return 'Connected Folders';
    }
  }
  return 'External';
}

/** List a filesystem directory via IPC and return typeahead items. */
function drillFilesystem(
  targetPath: string,
  filterText: string,
  snapshot: MentionSearchSnapshot
): Promise<TypeaheadItem[]> {
  const dirCategory = resolveDirectoryCategory(targetPath, snapshot);

  return filesApi.listDirectory
    .invoke({ dirPath: targetPath })
    .then((entries) => {
      const filtered = filterText
        ? entries.filter((e) => e.title.toLowerCase().includes(filterText))
        : entries;

      return filtered.map((entry) => ({
        id: entry.path,
        label: entry.title,
        description: entry.path.replace(/^\/Users\/[^/]+/, '~'),
        icon: entry.type === 'directory' ? FolderOpen : FileText,
        category: entry.type === 'directory' ? dirCategory : 'Files',
        data: entry.type === 'directory' ? 'directory' : 'file'
      }));
    })
    .catch((err) => {
      console.warn('[mentionSearch] Directory drill failed:', err);
      return [];
    });
}

// ── Drill search (query contains "/") ────────────────────────────────

function handleDrillSearch(
  query: string,
  store: JotaiStore,
  snapshot: MentionSearchSnapshot
): TypeaheadItem[] | Promise<TypeaheadItem[]> {
  const lastSlash = query.lastIndexOf('/');
  const pathPrefix = query.slice(0, lastSlash);
  const filterText = query.slice(lastSlash + 1).toLowerCase();

  // Absolute path → direct filesystem drill (connected folder / external root).
  // onDrill produces these when the user Tabs into a directory item whose id
  // is a full filesystem path, bypassing the Moss folder scan entirely.
  if (pathPrefix.startsWith('/')) {
    return drillFilesystem(pathPrefix, filterText, snapshot);
  }

  const noteIds = store.get(noteIdsAtom);

  // Collect notes whose folderPath starts with or equals the drill path
  const subFolderSet = new Set<string>();
  const matchingNotes: TypeaheadItem[] = [];

  for (const noteId of noteIds) {
    const entity = store.get(noteEntityAtom(noteId));
    if (!entity || entity.trashedAt != null) continue;

    const fp = entity.folderPath || 'Notes';

    if (fp === pathPrefix || fp === `Notes/${pathPrefix}`) {
      const lowerTitle = entity.title.toLowerCase();
      if (!filterText || lowerTitle.includes(filterText)) {
        matchingNotes.push({
          id: entity.id,
          label: entity.title,
          description: folderDisplayName(fp),
          icon: FileText,
          category: 'Notes',
          data: 'note'
        });
      }
    }

    const normalizedPrefix = fp.startsWith('Notes/') ? fp : `Notes/${fp}`;
    const searchPrefix = pathPrefix.startsWith('Notes/') ? pathPrefix : `Notes/${pathPrefix}`;
    if (normalizedPrefix.startsWith(searchPrefix + '/')) {
      const remainder = normalizedPrefix.slice(searchPrefix.length + 1);
      const nextSegment = remainder.split('/')[0];
      if (nextSegment) {
        subFolderSet.add(nextSegment);
      }
    }
  }

  const subFolderItems: TypeaheadItem[] = Array.from(subFolderSet)
    .filter((name) => !filterText || name.toLowerCase().includes(filterText))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      id: `${pathPrefix}/${name}`,
      label: name,
      description: undefined,
      icon: Folder,
      category: 'Moss Folders',
      data: 'folder'
    }));

  // If we found Moss folder matches, return them (sync)
  if (subFolderItems.length > 0 || matchingNotes.length > 0) {
    return [...subFolderItems, ...matchingNotes];
  }

  // -- Legacy fallback: display-name-based directory drill --
  // Kept for backwards compatibility with relative drill queries (e.g. from
  // comment input or other consumers that don't use absolute-path drills).
  const grantedDirs = snapshot.grantedDirs;
  const firstSlash = query.indexOf('/');
  const rootName = query.slice(0, firstSlash).toLowerCase();

  let dirMatch = grantedDirs.find((dirPath) => {
    const dirName = dirPath.split('/').filter(Boolean).pop() || '';
    return dirName.toLowerCase() === rootName;
  });

  // Fallback: match against externalRootPath values from note entities
  if (!dirMatch) {
    for (const noteId of noteIds) {
      const entity = store.get(noteEntityAtom(noteId));
      if (!entity || !entity.externalRootPath) continue;
      const dirName = entity.externalRootPath.split('/').filter(Boolean).pop() || '';
      if (dirName.toLowerCase() === rootName) {
        dirMatch = entity.externalRootPath.replace(/\/$/, '');
        break;
      }
    }
  }

  if (dirMatch) {
    const subPath = pathPrefix.slice(firstSlash + 1);
    const targetPath = subPath ? `${dirMatch}/${subPath}` : dirMatch;
    return drillFilesystem(targetPath, filterText, snapshot);
  }

  return [];
}
