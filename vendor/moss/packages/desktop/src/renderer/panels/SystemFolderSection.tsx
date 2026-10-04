// ported-from: packages/desktop/src/renderer/panels/SystemFolderSection.tsx @ 762abb777
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FolderOpen, FolderX, FolderInput, ExternalLink } from 'lucide-react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  externalFolderAtom,
  externalFolderNavigateAtom,
  expandedFoldersAtom,
  notesByFolderAtom,
  removeNoteEntityAtom,
  type NoteEntity,
} from '@moss/shared';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@moss/shared/components/ui/context-menu';
import { FolderGroup, FOLDER_HEADER_HEIGHT_PX } from './FolderGroup';
import { externalNotesApi, shellApi } from '../api/electron';
import { refreshConnectedFolderEntriesAtom, refreshGrantedDirsAtom } from '../state/granted-dirs-atoms';

/** Extract the last folder name from a directory path for display */
const folderBasename = (dirPath: string): string =>
  dirPath.split('/').filter(Boolean).pop() ?? dirPath;

const normalizeExternalPath = (path: string): string =>
  path.length > 1 ? path.replace(/\/+$/, '') : path;

const parentDir = (path: string): string => {
  const normalized = normalizeExternalPath(path);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '';
  return normalized.slice(0, index);
};

interface SystemFolderSectionProps {
  /** Render function for a note item */
  renderNoteItem: (note: {
    id: string;
    title: string;
    updatedAt: number;
    contentType: string;
    folderPath: string;
    externalFilePath?: string;
  }) => ReactNode;
  /** Compact mode: hide note counts, reduce padding */
  compact?: boolean;
}

interface ExternalFolderTreeNode {
  path: string;
  label: string;
  notes: NoteEntity[];
  children: ExternalFolderTreeNode[];
  totalNoteCount: number;
  canClose: boolean;
}

const externalFolderPath = (note: NoteEntity): string => {
  const fileParent = parentDir(note.externalFilePath ?? '');
  if (fileParent) return fileParent;
  return normalizeExternalPath(note.externalRootPath ?? '');
};

export function resolveExternalFolderRevealPath(notes: NoteEntity[], noteId: string): string | null {
  const note = notes.find((candidate) => candidate.id === noteId);
  if (!note) return null;
  return externalFolderPath(note) || null;
}

/**
 * Build the smallest useful tree around folders that contain open external
 * notes. Unary filesystem ancestor chains are omitted; nearby sibling folders
 * gain a shared parent only when that parent helps group relevant content.
 */
export function buildExternalFolderTree(
  notes: NoteEntity[]
): { roots: ExternalFolderTreeNode[]; ungrouped: NoteEntity[] } {
  const ungrouped: NoteEntity[] = [];
  const notesByPath = new Map<string, NoteEntity[]>();

  for (const note of notes) {
    const folderPath = externalFolderPath(note);
    if (!folderPath) {
      ungrouped.push(note);
      continue;
    }
    const folderNotes = notesByPath.get(folderPath) ?? [];
    folderNotes.push(note);
    notesByPath.set(folderPath, folderNotes);
  }

  // Add a shared parent only when it groups multiple relevant child folders.
  // Repeating this allows compact branching trees without ever adding unary
  // ancestor chains that carry no useful sidebar information.
  const includedPaths = new Set(notesByPath.keys());
  let addedParent = true;
  while (addedParent) {
    addedParent = false;
    const childrenByParent = new Map<string, string[]>();
    for (const path of includedPaths) {
      const parent = parentDir(path);
      if (!parent) continue;
      const children = childrenByParent.get(parent) ?? [];
      children.push(path);
      childrenByParent.set(parent, children);
    }
    for (const [parent, children] of childrenByParent) {
      if (children.length < 2 || includedPaths.has(parent)) continue;
      includedPaths.add(parent);
      addedParent = true;
    }
  }

  const nodesByPath = new Map<string, ExternalFolderTreeNode>();
  for (const path of includedPaths) {
    const folderNotes = notesByPath.get(path) ?? [];
    nodesByPath.set(path, {
      path,
      label: folderBasename(path),
      notes: folderNotes,
      children: [],
      totalNoteCount: folderNotes.length,
      canClose: true
    });
  }

  const roots: ExternalFolderTreeNode[] = [];
  for (const node of nodesByPath.values()) {
    let ancestor = parentDir(node.path);
    while (ancestor && !nodesByPath.has(ancestor)) {
      ancestor = parentDir(ancestor);
    }
    const parent = ancestor ? nodesByPath.get(ancestor) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortAndCount = (node: ExternalFolderTreeNode): number => {
    node.children.sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
    let count = node.notes.length;
    for (const child of node.children) count += sortAndCount(child);
    node.totalNoteCount = count;
    return count;
  };
  roots.sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
  for (const root of roots) sortAndCount(root);

  return { roots, ungrouped };
}

export function SystemFolderSection({
  renderNoteItem,
  compact,
}: SystemFolderSectionProps) {
  const externalFolder = useAtomValue(externalFolderAtom);
  const notesByFolder = useAtomValue(notesByFolderAtom);
  const expandedFolders = useAtomValue(expandedFoldersAtom);

  const externalPath = externalFolder?.path ?? 'Notes/External';
  const notes = notesByFolder.get(externalPath) ?? [];
  const noteCount = externalFolder?.noteCount ?? notes.length;
  const isExpanded = expandedFolders.has(externalPath);

  if (noteCount === 0 && notes.length === 0) {
    return null;
  }

  return (
    <FolderGroup
      name="External"
      path={externalPath}
      noteCount={noteCount}
      icon={FolderInput}
      variant="system"
      compact={compact}
    >
      {isExpanded ? <ExternalNotesList notes={notes} renderNoteItem={renderNoteItem} /> : null}
    </FolderGroup>
  );
}


/**
 * Renders a pruned tree of folders that contain open external notes.
 *
 * Only relevant containing folders and useful shared parents appear. Filesystem
 * ancestor chains that add no grouping value stay out of the sidebar.
 */
function ExternalNotesList({
  notes,
  renderNoteItem
}: {
  notes: NoteEntity[];
  renderNoteItem: SystemFolderSectionProps['renderNoteItem'];
}) {
  const { roots, ungrouped } = useMemo(() => buildExternalFolderTree(notes), [notes]);
  const store = useStore();
  const removeNoteEntity = useSetAtom(removeNoteEntityAtom);
  const navigateTarget = useAtomValue(externalFolderNavigateAtom);
  const setNavigateTarget = useSetAtom(externalFolderNavigateAtom);

  // Track open/closed state for all folders. Default: all collapsed.
  // Matches internal folders (expandedFoldersAtom starts as empty set).
  // Folders are added when the user expands them.
  const innerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set<string>());

  const toggleFolder = useCallback((path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      // In both cases, collapse all descendant folders
      for (const p of prev) {
        if (p.startsWith(path + '/')) next.delete(p);
      }
      return next;
    });
  }, []);

  // Handle breadcrumb navigation: expand ancestors and scroll to target folder
  useEffect(() => {
    if (!navigateTarget) return;
    setNavigateTarget(null);

    // Collect all tree node paths to find which ones are ancestors of the target
    const allNodes = new Map<string, ExternalFolderTreeNode>();
    const walk = (list: ExternalFolderTreeNode[]) => {
      for (const node of list) {
        allNodes.set(node.path, node);
        walk(node.children);
      }
    };
    walk(roots);

    // Expand the target and all its ancestors
    setOpenFolders((prev) => {
      const next = new Set(prev);
      for (const [path] of allNodes) {
        // A path is an ancestor if the target starts with it
        if (navigateTarget === path || navigateTarget.startsWith(path + '/')) {
          next.add(path);
        }
      }
      return next;
    });

    // Scroll to and flash the folder element after DOM updates
    const outerTimer = setTimeout(() => {
      const allFolders = document.querySelectorAll('[data-external-folder-path]');
      for (const el of allFolders) {
        if (el.getAttribute('data-external-folder-path') === navigateTarget) {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          (el as HTMLElement).classList.add('bg-border-subtle/60');
          (el as HTMLElement).style.transition = 'background-color 0.6s';
          const innerTimer = setTimeout(() => {
            (el as HTMLElement).classList.remove('bg-border-subtle/60');
          }, 400);
          innerTimerRef.current = innerTimer;
          break;
        }
      }
    }, 150);

    return () => {
      clearTimeout(outerTimer);
      if (innerTimerRef.current) {
        clearTimeout(innerTimerRef.current);
        innerTimerRef.current = null;
      }
    };
  }, [navigateTarget, roots, setNavigateTarget]);

  const handleCloseFolder = useCallback(async (rootPath: string) => {
    try {
      const closedIds = await externalNotesApi.closeByRoot.invoke(rootPath);
      if (closedIds) {
        for (const id of closedIds) {
          removeNoteEntity(id);
        }
      }
      setOpenFolders((prev) => {
        const next = new Set(prev);
        next.delete(rootPath);
        for (const path of prev) {
          if (path.startsWith(rootPath + '/')) {
            next.delete(path);
          }
        }
        return next;
      });
      await store.set(refreshGrantedDirsAtom);
      void store.set(refreshConnectedFolderEntriesAtom);
    } catch (err) {
      console.warn('[ExternalNotesList] Failed to close folder:', err);
    }
  }, [removeNoteEntity, store]);

  const renderNote = (note: NoteEntity) =>
    renderNoteItem({
      id: note.id,
      title: note.title,
      updatedAt: note.updatedAt,
      contentType: note.contentType ?? 'empty',
      folderPath: note.folderPath ?? 'Notes',
      externalFilePath: note.externalFilePath
    });


  const renderSubFolder = (child: ExternalFolderTreeNode, depth: number) => {
    const isOpen = openFolders.has(child.path);

    return (
      <ContextMenu key={child.path}>
        <ContextMenuTrigger asChild>
          <div>
            {/* Sub-folder row — clickable to toggle, sticky when open */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggleFolder(child.path)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFolder(child.path); } }}
              style={isOpen ? { top: depth * FOLDER_HEADER_HEIGHT_PX, zIndex: 10 - depth } : undefined}
              className={[
                'flex h-sidebar-folder-header cursor-pointer items-center gap-sidebar-row-gap px-sidebar-row-x py-sidebar-row-y bg-surface-notes-list hover:bg-surface-note-hover transition-colors focus:outline-none',
                isOpen && 'sticky'
              ].filter(Boolean).join(' ')}
              data-external-folder-path={child.path}
              aria-expanded={isOpen}
              aria-label={`${child.label} folder`}
            >
              {isOpen
                ? <FolderOpen className={`h-4 w-4 shrink-0 text-ink-faint/60 [stroke-width:1.5] ${child.totalNoteCount > 0 ? 'fill-ink-faint/10' : 'fill-none'}`} />
                : <Folder className={`h-4 w-4 shrink-0 text-ink-faint/60 [stroke-width:1.5] ${child.totalNoteCount > 0 ? 'fill-ink-faint/10' : 'fill-none'}`} />}
              <span className="min-w-0 truncate text-caption font-book text-ink-faint">
                {child.label}
              </span>
            </div>
            {/* Indented notes + nested sub-folders */}
            {isOpen && (
              <div className="ml-sidebar-indent border-l border-border-clear pl-2 pt-0.5">
                <div className="flex flex-col gap-sidebar-list-gap">
                  {child.notes.map((note) => (
                    <div key={note.id}>
                      {renderNote(note)}
                    </div>
                  ))}
                  {child.children.map((c) => renderSubFolder(c, depth + 1))}
                </div>
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => {
            shellApi.revealPath.invoke(child.path).catch((err) => {
              console.warn('[ExternalNotesList] Failed to open in Finder:', err);
            });
          }}>
            <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
            <span>Open in Finder</span>
          </ContextMenuItem>
          {child.canClose ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => handleCloseFolder(child.path)}>
                <FolderX className="h-3.5 w-3.5 text-ink-muted" />
                <span>Close Folder</span>
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <>
      {/* Ungrouped notes (no directory info) */}
      {ungrouped.map((note) => (
        <div key={note.id}>
          {renderNote(note)}
        </div>
      ))}

      {roots.map((root) => {
        const isRootOpen = openFolders.has(root.path);

        return (
          <ContextMenu key={root.path}>
            <ContextMenuTrigger asChild>
              <div>
                {/* Root directory row — clickable to toggle, sticky when open */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleFolder(root.path)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFolder(root.path); } }}
                  style={isRootOpen ? { top: FOLDER_HEADER_HEIGHT_PX, zIndex: 9 } : undefined}
                  className={[
                    'flex h-sidebar-folder-header cursor-pointer items-center gap-sidebar-row-gap px-sidebar-row-x py-sidebar-row-y bg-surface-notes-list hover:bg-surface-note-hover transition-colors focus:outline-none',
                    isRootOpen && 'sticky'
                  ].filter(Boolean).join(' ')}
                  data-external-folder-path={root.path}
                  aria-expanded={isRootOpen}
                  aria-label={`${root.label} folder`}
                >
                  {isRootOpen
                    ? <FolderOpen className={`h-4 w-4 shrink-0 text-ink-faint/60 [stroke-width:1.5] ${root.totalNoteCount > 0 ? 'fill-ink-faint/10' : 'fill-none'}`} />
                    : <Folder className={`h-4 w-4 shrink-0 text-ink-faint/60 [stroke-width:1.5] ${root.totalNoteCount > 0 ? 'fill-ink-faint/10' : 'fill-none'}`} />}
                  <span className="min-w-0 truncate text-caption font-book text-ink-faint">
                    {root.label}
                  </span>
                </div>
                {/* Root contents (notes + sub-folders), indented */}
                {isRootOpen && (
                  <div className="ml-sidebar-indent border-l border-border-clear pl-2 pt-0.5">
                    <div className="flex flex-col gap-sidebar-list-gap">
                      {root.notes.map((note) => (
                        <div key={note.id}>
                          {renderNote(note)}
                        </div>
                      ))}
                      {root.children.map((c) => renderSubFolder(c, 2))}
                    </div>
                  </div>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => {
                shellApi.revealPath.invoke(root.path).catch((err) => {
                  console.warn('[ExternalNotesList] Failed to open in Finder:', err);
                });
              }}>
                <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
                <span>Open in Finder</span>
              </ContextMenuItem>
              {root.canClose ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => handleCloseFolder(root.path)}>
                    <FolderX className="h-3.5 w-3.5 text-ink-muted" />
                    <span>Close Folder</span>
                  </ContextMenuItem>
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </>
  );
}

export default SystemFolderSection;
