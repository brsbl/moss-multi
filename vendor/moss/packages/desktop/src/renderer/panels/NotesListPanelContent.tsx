// ported-from: packages/desktop/src/renderer/panels/NotesListPanelContent.tsx @ 762abb777
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { ArrowDownZA, ArrowUpAZ, ChevronDown, ChevronRight, ChevronUp, ClockArrowDown, ClockArrowUp, Columns2, Copy, Folder, FolderOpen, FolderPlus, Link, Pencil, Pin, SearchX, Trash2, FileX, ExternalLink } from 'lucide-react';
import {
  NotesListPanel,
  NoteCard,
  activeNoteIdAtom,
  notesHydratedAtom,
  noteListEntityAtom,
  lastViewedNoteIdAtom,
  userFolderListAtom,
  notesByFolderAtom,
  expandedFoldersAtom,
  backendFoldersAtom,
  activeFolderPathAtom,
  uiAgentBusyNoteIdsAtom,
  syncNoteEntityAtom,
  noteEntityAtom,
  noteIdsAtom,
  removeNoteEntityAtom,
  mapNoteMetadataToNoteEntity,
  notesSortModeAtom,
  notesSortDirectionAtom,
  pinnedNotesAtom,
  unpinnedRootNotesAtom,
  pinnedSectionExpandedAtom,
  openSplitTabAtom,
  type NotesListPanelHandle,
} from '@moss/shared';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@moss/shared/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import type { ListFoldersOptions, NoteSearchResult } from '../../common/noteTypes';
import { notesApi, filesApi, externalNotesApi, systemApi } from '../api/electron';
import { formatRelativeTime } from './notesPanelUtils';
import { FolderGroup } from './FolderGroup';
import { SystemFolderSection } from './SystemFolderSection';
import { foldersApi } from '../api/electron';
// moss-multi seam: hide-registry (A§9); sidebar rows and slots (A§19, A§11)
import { hidden } from '@moss-multi/host/affordances';
import { FolderMenuItems, surfacedShared, surfacedFolder } from '@moss-multi/host/slots';

const NOTES_FOLDER_NAME = 'Notes';
const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

type RenderableNoteListItem = {
  id: string;
  title: string;
  updatedAt: number;
  contentType: string;
  folderPath: string;
  externalFilePath?: string;
  pinned?: boolean;
  pinnedAt?: number | null;
};

type NoteItemOptions = {
  breadcrumb?: string;
  showMeta?: boolean;
  draggable?: boolean;
  isSelected?: boolean;
  selectedCardRef?: (el: HTMLElement | null) => void;
  showActiveState?: boolean;
};

const useIsActiveNote = (noteId: string): boolean => {
  const isActiveAtom = useMemo(
    () => atom((get) => get(activeNoteIdAtom) === noteId),
    [noteId]
  );
  return useAtomValue(isActiveAtom);
};

const useIsNotePinned = (noteId: string): boolean => {
  const isPinnedAtom = useMemo(
    () => atom((get) => get(noteEntityAtom(noteId))?.pinned === true),
    [noteId]
  );
  return useAtomValue(isPinnedAtom);
};

const useNoteExternalFilePath = (noteId: string): string | undefined => {
  const externalPathAtom = useMemo(
    () => atom((get) => get(noteEntityAtom(noteId))?.externalFilePath),
    [noteId]
  );
  return useAtomValue(externalPathAtom);
};

type NoteContextMenuHandlers = {
  handleTogglePin: (noteId: string) => void;
  handleOpenInNewWindow: (noteId: string) => void;
  openSplitTab: (noteId: string) => void;
  handleCopyLink: (noteId: string, noteTitle: string) => void;
  handleShowInFinder: (noteId: string) => void;
  handleCloseExternalNote: (noteId: string) => void;
  onRenameNote?: (id: string) => void;
  onDuplicateNote?: (id: string) => void;
  onDeleteNote?: (id: string) => void;
};

type NoteContextMenuItemsProps = NoteContextMenuHandlers & {
  noteId: string;
  noteTitle: string;
  pinned: boolean;
  externalFilePath?: string;
  isActive: boolean;
};

// One menu for both row types. Ordinary rows and search-result rows are
// separate components, so without this the menu silently exists on only one.
function NoteContextMenuItems({
  noteId,
  noteTitle,
  pinned,
  externalFilePath,
  isActive,
  handleTogglePin,
  handleOpenInNewWindow,
  openSplitTab,
  handleCopyLink,
  handleShowInFinder,
  handleCloseExternalNote,
  onRenameNote,
  onDuplicateNote,
  onDeleteNote
}: NoteContextMenuItemsProps) {
  // moss-multi seam: transfer Rename focus after the menu releases it.
  const renameOnClose = useRef(false);
  return (
    <ContextMenuContent onCloseAutoFocus={(event) => {
      if (!renameOnClose.current) return;
      renameOnClose.current = false;
      event.preventDefault();
      onRenameNote?.(noteId);
    }}>
      <ContextMenuItem onSelect={() => handleOpenInNewWindow(noteId)}>
        <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
        <span>Open in New Window</span>
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => openSplitTab(noteId)}
        disabled={isActive || (typeof window !== 'undefined' && window.innerWidth < 768)}
      >
        <Columns2 className="h-3.5 w-3.5 text-ink-muted" />
        <span>Open in Split Tab</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => handleTogglePin(noteId)}>
        <Pin className="h-3.5 w-3.5 text-ink-muted" />
        <span>{pinned ? 'Unpin' : 'Pin'}</span>
      </ContextMenuItem>
      {onRenameNote && !externalFilePath && (
        <ContextMenuItem onSelect={() => { renameOnClose.current = true; }}>
          <Pencil className="h-3.5 w-3.5 text-ink-muted" />
          <span>Rename</span>
        </ContextMenuItem>
      )}
      {onDuplicateNote && !externalFilePath && (
        <ContextMenuItem onSelect={() => onDuplicateNote(noteId)}>
          <Copy className="h-3.5 w-3.5 text-ink-muted" />
          <span>Duplicate</span>
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => { void handleCopyLink(noteId, noteTitle); }}>
        <Link className="h-3.5 w-3.5 text-ink-muted" />
        <span>Copy Link</span>
      </ContextMenuItem>
      {/* moss-multi seam: hide-registry (A§9) */}
      {hidden('reveal-in-finder') ? null : (
      <ContextMenuItem onSelect={() => handleShowInFinder(noteId)}>
        <FolderOpen className="h-3.5 w-3.5 text-ink-muted" />
        <span>Open in Finder</span>
      </ContextMenuItem>
      )}
      {externalFilePath ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleCloseExternalNote(noteId)}>
            <FileX className="h-3.5 w-3.5 text-ink-muted" />
            <span>Close</span>
          </ContextMenuItem>
        </>
      ) : onDeleteNote && !hidden('trash') /* moss-multi seam: hide-registry (A§9) */ ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onDeleteNote(noteId)}>
            <Trash2 className="h-3.5 w-3.5 text-accent-terracotta" />
            <span>Trash</span>
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
  );
}

type NoteListItemWithMenuProps = {
  note: RenderableNoteListItem;
  options?: NoteItemOptions;
  activeCardRef: (el: HTMLElement | null) => void;
  agentBusyNoteIds: Set<string>;
  draggingNoteId: string | null;
  handleSelectNote: (id: string) => void;
  handleTogglePin: (noteId: string) => void;
  handleOpenInNewWindow: (noteId: string) => void;
  openSplitTab: (noteId: string) => void;
  handleCopyLink: (noteId: string, noteTitle: string) => void;
  handleShowInFinder: (noteId: string) => void;
  handleCloseExternalNote: (noteId: string) => void;
  onRenameNote?: (id: string) => void;
  onDuplicateNote?: (id: string) => void;
  onDeleteNote?: (id: string) => void;
  isSearchActive: boolean;
  panelRef: React.RefObject<NotesListPanelHandle | null>;
  setDraggingNoteId: (noteId: string | null) => void;
  setDragOverTarget: (target: string | null) => void;
};

const NoteListItemWithMenu = memo(function NoteListItemWithMenu({
  note,
  options,
  activeCardRef,
  agentBusyNoteIds,
  draggingNoteId,
  handleSelectNote,
  handleTogglePin,
  handleOpenInNewWindow,
  openSplitTab,
  handleCopyLink,
  handleShowInFinder,
  handleCloseExternalNote,
  onRenameNote,
  onDuplicateNote,
  onDeleteNote,
  isSearchActive,
  panelRef,
  setDraggingNoteId,
  setDragOverTarget
}: NoteListItemWithMenuProps) {
  const isActive = useIsActiveNote(note.id);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  // moss-multi seam: shared-rows (A§11: a surfaced shared row offers no move)
  const draggable = (options?.draggable ?? true) && !surfacedShared(note.id);
  const showActiveState = options?.showActiveState ?? true;
  const isVisuallyActive = showActiveState && isActive;
  const cardRef = options?.isSelected
    ? options.selectedCardRef
    : isVisuallyActive
      ? activeCardRef
      : undefined;

  return (
    <ContextMenu onOpenChange={setIsContextMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          ref={cardRef}
          // moss-multi seam: sidebar-row (A§19)
          data-sidebar-row=""
          data-doc-id={note.id}
          data-active={isVisuallyActive ? 'true' : 'false'}
        >
          <NoteCard
            id={note.id}
            title={note.title}
            updatedAt={note.updatedAt}
            formattedTime={formatRelativeTime(note.updatedAt)}
            isActive={isVisuallyActive}
            isSelected={options?.isSelected}
            hasActiveAgent={agentBusyNoteIds.has(note.id)}
            isDragging={note.id === draggingNoteId}
            isContextMenuOpen={isContextMenuOpen}
            draggable={draggable}
            variant="compact"
            showMeta={options?.showMeta ?? true}
            pinned={note.pinned}
            onTogglePin={handleTogglePin}
            breadcrumb={options?.breadcrumb}
            onSelect={(id) => {
              handleSelectNote(id);
              if (isSearchActive) {
                panelRef.current?.blurSearch();
              }
            }}
            onDragStart={draggable ? (e) => {
              e.dataTransfer.setData('text/plain', note.id);
              e.dataTransfer.effectAllowed = 'move';
              setDraggingNoteId(note.id);
            } : undefined}
            onDragEnd={draggable ? () => {
              setDraggingNoteId(null);
              setDragOverTarget(null);
            } : undefined}
          />
        </div>
      </ContextMenuTrigger>
      <NoteContextMenuItems
        noteId={note.id}
        noteTitle={note.title}
        pinned={note.pinned === true}
        externalFilePath={note.externalFilePath}
        isActive={isActive}
        handleTogglePin={handleTogglePin}
        handleOpenInNewWindow={handleOpenInNewWindow}
        openSplitTab={openSplitTab}
        handleCopyLink={handleCopyLink}
        handleShowInFinder={handleShowInFinder}
        handleCloseExternalNote={handleCloseExternalNote}
        onRenameNote={onRenameNote}
        onDuplicateNote={onDuplicateNote}
        onDeleteNote={onDeleteNote}
      />
    </ContextMenu>
  );
});

type SearchResultNoteCardProps = NoteContextMenuHandlers & {
  result: NoteSearchResult;
  agentBusyNoteIds: Set<string>;
  draggingNoteId: string | null;
  highlightQuery: string;
  handleSelectNote: (id: string) => void;
  panelRef: React.RefObject<NotesListPanelHandle | null>;
  isSelected?: boolean;
  showActiveState?: boolean;
};

const SearchResultNoteCard = memo(function SearchResultNoteCard({
  result,
  agentBusyNoteIds,
  draggingNoteId,
  highlightQuery,
  handleSelectNote,
  panelRef,
  isSelected = false,
  showActiveState = true,
  ...menuHandlers
}: SearchResultNoteCardProps) {
  const isActive = useIsActiveNote(result.id);
  const isPinned = useIsNotePinned(result.id);
  const externalFilePath = useNoteExternalFilePath(result.id);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);

  return (
    <ContextMenu onOpenChange={setIsContextMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          // moss-multi seam: sidebar-row (A§19)
          data-sidebar-row=""
          data-doc-id={result.id}
          data-active={showActiveState && isActive ? 'true' : 'false'}
        >
          <NoteCard
            id={result.id}
            title={result.title}
            updatedAt={result.updatedAt ?? 0}
            formattedTime={result.updatedAt ? formatRelativeTime(result.updatedAt) : ''}
            isActive={showActiveState && isActive}
            isSelected={isSelected}
            hasActiveAgent={agentBusyNoteIds.has(result.id)}
            isDragging={result.id === draggingNoteId}
            isContextMenuOpen={isContextMenuOpen}
            variant="compact"
            snippet={result.snippet}
            highlightQuery={highlightQuery}
            pinned={isPinned}
            onTogglePin={menuHandlers.handleTogglePin}
            onSelect={(id) => {
              handleSelectNote(id);
              // These rows only render while a search is active, so the blur is
              // unconditional here — matching what ordinary rows do when
              // `isSearchActive`. Without it, opening a note from a content
              // match left focus in the search box but a title match didn't.
              panelRef.current?.blurSearch();
            }}
          />
        </div>
      </ContextMenuTrigger>
      <NoteContextMenuItems
        {...menuHandlers}
        noteId={result.id}
        noteTitle={result.title}
        pinned={isPinned}
        externalFilePath={externalFilePath}
        isActive={isActive}
      />
    </ContextMenu>
  );
});


type NotesListPanelContentProps = {
  onSelectNote: (id: string) => void;
  onCreateNote: () => void;
  onDeleteNote?: (id: string) => void;
  onDuplicateNote?: (id: string) => void;
  onRenameNote?: (id: string) => void;
  onRefreshNotes?: () => void;
  onCollapse?: () => void;
  footerContent?: React.ReactNode;
};

export type NotesListPanelContentHandle = {
  focusSearch: () => void;
  blurSearch: () => void;
  expandSearch: () => void;
};

const NotesListPanelContentComponent = forwardRef<NotesListPanelContentHandle, NotesListPanelContentProps>(
  function NotesListPanelContent({ onSelectNote, onCreateNote, onDeleteNote, onDuplicateNote, onRenameNote, onRefreshNotes: _onRefreshNotes, onCollapse, footerContent }, ref) {
    const noteList = useAtomValue(noteListEntityAtom);
    const derivedFolderList = useAtomValue(userFolderListAtom);
    const notesByFolder = useAtomValue(notesByFolderAtom);
    const agentBusyNoteIds = useAtomValue(uiAgentBusyNoteIdsAtom);
    const setLastViewedNoteId = useSetAtom(lastViewedNoteIdAtom);
    const setBackendFolders = useSetAtom(backendFoldersAtom);
    const [expandedFolders, setExpandedFolders] = useAtom(expandedFoldersAtom);
    const store = useStore();
    const setActiveFolderPath = useSetAtom(activeFolderPathAtom);
    const [sortMode, setSortMode] = useAtom(notesSortModeAtom);
    const [sortDirection, setSortDirection] = useAtom(notesSortDirectionAtom);
    const pinnedNotes = useAtomValue(pinnedNotesAtom);
    const rootNotes = useAtomValue(unpinnedRootNotesAtom);
    const [pinnedSectionExpanded, setPinnedSectionExpanded] = useAtom(pinnedSectionExpandedAtom);
    const openSplitTab = useSetAtom(openSplitTabAtom);
    const panelRef = useRef<NotesListPanelHandle>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isSearchActive, setIsSearchActive] = useState(false);

    // Clean up pending debounce timer on unmount
    useEffect(() => {
      return () => {
        if (ipcSearchTimerRef.current) clearTimeout(ipcSearchTimerRef.current);
      };
    }, []);

    // Scroll the active note card into view via ref callback — fires when
    // React mounts or updates the active card element. Gated behind hydration
    // to prevent repeated scroll-jank while hundreds of notes stream in.
    const notesHydrated = useAtomValue(notesHydratedAtom);
    const activeCardRef = useCallback((el: HTMLElement | null) => {
      if (!el || !notesHydrated) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }, [notesHydrated]);

    const [ipcSearchResults, setIpcSearchResults] = useState<NoteSearchResult[]>([]);
    const ipcSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const ipcSearchRequestIdRef = useRef(0);
    const hasPanelSearchQuery = searchQuery.trim().length > 0;

    // Membership signature of the note list (ids only — not timestamps). Changes
    // when a note is added, removed, or moved-away on disk. Used to re-run the IPC
    // search so stale entries (e.g. a moved-away note) drop out of results instead
    // of lingering in the last snapshot until the user re-types the query.
    const noteIdMembershipKey = useMemo(
      () => noteList.map((note) => note.id).sort().join('\0'),
      [noteList]
    );

    // Inline folder creation state
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [folderError, setFolderError] = useState<string | null>(null);
    const [creatingFolderParentPath, setCreatingFolderParentPath] = useState<string | undefined>(undefined);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const isSubmittingRef = useRef(false);

    // Drag-and-drop state
    const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
    const [draggingFolderPath, setDraggingFolderPath] = useState<string | null>(null);
    const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
    const [trashFolderTarget, setTrashFolderTarget] = useState<string | null>(null);

    // Fetch folders from backend on mount and after folder operations
    const fetchBackendFolders = useCallback(async (options?: ListFoldersOptions) => {
      try {
        const folders = await foldersApi.list.invoke(options);
        // Update the global backendFoldersAtom so folderListAtom can merge it
        setBackendFolders(folders.map((f) => ({
          name: f.name,
          path: f.path,
          noteCount: f.noteCount,
          createdAt: f.createdAt ?? 0,
          type: f.type
        })));
      } catch (err) {
        // Derived folders still work as fallback, but log for debugging
        console.warn('[FolderList] Failed to fetch backend folders:', err);
        setBackendFolders([]);
      }
    }, [setBackendFolders]);

    useEffect(() => {
      fetchBackendFolders();
    }, [fetchBackendFolders]);

    const runIpcSearch = useCallback(async (query: string) => {
      if (ipcSearchTimerRef.current) clearTimeout(ipcSearchTimerRef.current);
      const requestId = ++ipcSearchRequestIdRef.current;
      setIpcSearchResults([]);
      if (!query.trim()) {
        return;
      }
      ipcSearchTimerRef.current = setTimeout(async () => {
        try {
          const results = await notesApi.search.invoke({
            query,
            limit: 20,
            excludeNoteId: undefined
          });
          if (requestId !== ipcSearchRequestIdRef.current) return;
          setIpcSearchResults(results);
        } catch (err) {
          if (requestId !== ipcSearchRequestIdRef.current) return;
          console.warn('[NotesListPanel] IPC search failed:', err);
          setIpcSearchResults([]);
        }
      }, 150);
    }, []);

    // Latest search state for the membership-change reconcile below — held in a ref
    // so the reconcile fires only when the note-id set changes, not every keystroke.
    const searchReconcileRef = useRef({ active: hasPanelSearchQuery, query: searchQuery });
    searchReconcileRef.current = { active: hasPanelSearchQuery, query: searchQuery };

    // When the set of notes changes while a search is active (a note was removed or
    // moved-away on disk), re-run the IPC search so results reflect the current
    // on-disk state instead of leaving a stale entry in the previous snapshot.
    useEffect(() => {
      if (searchReconcileRef.current.active) {
        void runIpcSearch(searchReconcileRef.current.query);
      }
    }, [noteIdMembershipKey, runIpcSearch]);

    // Use derived folder list — already sorted by folderListAtom (respects sort mode/direction)
    const folderList = derivedFolderList;

    // Top-level folders and a map of parent -> children for nested rendering
    const { topLevelFolders, childFoldersByParent } = useMemo(() => {
      const top = folderList.filter((f) => !f.parentPath);
      const children = new Map<string, typeof folderList>();
      for (const folder of folderList) {
        if (folder.parentPath) {
          const siblings = children.get(folder.parentPath) ?? [];
          siblings.push(folder);
          children.set(folder.parentPath, siblings);
        }
      }
      return { topLevelFolders: top, childFoldersByParent: children };
    }, [folderList]);

    useImperativeHandle(ref, () => ({
      focusSearch: () => panelRef.current?.focusSearch(),
      blurSearch: () => panelRef.current?.blurSearch(),
      expandSearch: () => panelRef.current?.expandSearch()
    }), []);

    const filteredNotes = useMemo(() => {
      const query = searchQuery.trim().toLowerCase();
      if (query === '') {
        return noteList;
      }
      return noteList.filter((note) =>
        note.title.toLowerCase().includes(query)
      );
    }, [noteList, searchQuery]);

    const hasAnyNotes = noteList.length > 0;

    // When search is active, show flat list; otherwise show grouped
    const searchNavigationNoteIds = useMemo(() => {
      if (hasPanelSearchQuery && ipcSearchResults.length > 0) {
        return ipcSearchResults.map((result) => result.id);
      }
      return filteredNotes.map((note) => note.id);
    }, [filteredNotes, hasPanelSearchQuery, ipcSearchResults]);
    const searchNavigationKey = useMemo(
      () => searchNavigationNoteIds.join('\0'),
      [searchNavigationNoteIds]
    );
    const selectedSearchNoteId =
      hasPanelSearchQuery ? searchNavigationNoteIds[selectedIndex] ?? null : null;
    const selectedSearchCardRef = useCallback((el: HTMLElement | null) => {
      if (!el || !selectedSearchNoteId) return;
      el.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    }, [selectedSearchNoteId]);

    // Reset selection when filtered results change
    useEffect(() => {
      setSelectedIndex(0);
    }, [searchNavigationKey, searchQuery]);

    const handleSelectNote = useCallback(
      (id: string) => {
        setLastViewedNoteId(id);
        onSelectNote(id);
      },
      [onSelectNote, setLastViewedNoteId]
    );

    const handleSearchChange = useCallback((value: string) => {
      setSearchQuery(value);
      void runIpcSearch(value);
    }, [runIpcSearch]);

    const handleSearchClear = useCallback(() => {
      setSearchQuery('');
      setSelectedIndex(0);
      ipcSearchRequestIdRef.current += 1;
      setIpcSearchResults([]);
      if (ipcSearchTimerRef.current) clearTimeout(ipcSearchTimerRef.current);
    }, []);

    const handleSearchArrowDown = useCallback(() => {
      if (searchNavigationNoteIds.length === 0) return;
      setSelectedIndex((prev) => (prev + 1) % searchNavigationNoteIds.length);
    }, [searchNavigationNoteIds.length]);

    const handleSearchArrowUp = useCallback(() => {
      if (searchNavigationNoteIds.length === 0) return;
      setSelectedIndex((prev) => (prev - 1 + searchNavigationNoteIds.length) % searchNavigationNoteIds.length);
    }, [searchNavigationNoteIds.length]);

    const handleSearchEnter = useCallback(() => {
      if (searchNavigationNoteIds.length > 0 && selectedIndex < searchNavigationNoteIds.length) {
        const noteId = searchNavigationNoteIds[selectedIndex];
        handleSelectNote(noteId);
        panelRef.current?.blurSearch();
      }
    }, [searchNavigationNoteIds, selectedIndex, handleSelectNote]);

    // Inline folder creation handlers
    const handleStartCreateFolder = useCallback((parentPath?: string) => {
      setIsCreatingFolder(true);
      setNewFolderName('');
      setFolderError(null);
      setCreatingFolderParentPath(parentPath);
      // Expand parent folder so subfolder input is visible
      if (parentPath) {
        setExpandedFolders((prev) => {
          if (prev.has(parentPath)) return prev;
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
      }
      // Focus input after state update
      setTimeout(() => folderInputRef.current?.focus(), 0);
    }, [setExpandedFolders]);

    const handleOpenDirectory = useCallback(async () => {
      try {
        const records = await filesApi.open.invoke({ surface: 'notes_list_header' });
        if (records?.length) {
          const folderPathsToExpand = new Set<string>();
          let firstFolderPath: string | null = null;

          for (const record of records) {
            const entity = mapNoteMetadataToNoteEntity(record);
            store.set(noteEntityAtom(entity.id), entity);

            const folderPath = record.folderPath ?? NOTES_FOLDER_NAME;
            if (!firstFolderPath && folderPath !== NOTES_FOLDER_NAME) {
              firstFolderPath = folderPath;
            }

            let currentPath = folderPath;
            while (currentPath && currentPath !== NOTES_FOLDER_NAME) {
              folderPathsToExpand.add(currentPath);
              const lastSlash = currentPath.lastIndexOf('/');
              currentPath = lastSlash > 0 ? currentPath.slice(0, lastSlash) : '';
            }
          }
          store.set(noteIdsAtom, (prev) => {
            const next = new Set(prev);
            for (const record of records) next.add(record.id);
            return next;
          });

          if (folderPathsToExpand.size > 0) {
            setExpandedFolders((prev) => {
              let changed = false;
              const next = new Set(prev);
              for (const path of folderPathsToExpand) {
                if (!next.has(path)) {
                  next.add(path);
                  changed = true;
                }
              }
              return changed ? next : prev;
            });
          }

          if (firstFolderPath) {
            setActiveFolderPath(firstFolderPath);
          }
        }
      } catch {
        // User cancelled
      }
    }, [setActiveFolderPath, setExpandedFolders, store]);

    const handleCancelCreateFolder = useCallback(() => {
      // Don't cancel if we're in the middle of submitting - the blur event
      // fires before the async IPC call completes, so we need to guard here
      if (isSubmittingRef.current) {
        return;
      }
      setIsCreatingFolder(false);
      setNewFolderName('');
      setFolderError(null);
      setCreatingFolderParentPath(undefined);
    }, []);

    const handleCreateFolder = useCallback(async () => {
      const trimmed = newFolderName.trim();

      // Validation
      if (trimmed.length === 0) {
        setFolderError('Name required');
        return;
      }
      if (trimmed.includes('/')) {
        setFolderError('/ is reserved as a path separator');
        return;
      }
      if (/[<>:"\\|?*]/.test(trimmed)) {
        setFolderError('Invalid characters');
        return;
      }
      // Check for duplicate names among siblings at the same level
      const siblingFolders = folderList.filter((f) => f.parentPath === creatingFolderParentPath);
      const existingNames = siblingFolders.map((f) => f.name.toLowerCase());
      if (existingNames.includes(trimmed.toLowerCase())) {
        setFolderError('Already exists');
        return;
      }

      // Prevent blur from cancelling while we submit
      isSubmittingRef.current = true;

      try {
        // Create folder via IPC (creates actual directory with .folder.json)
        await foldersApi.create.invoke({
          name: trimmed,
          noteIds: [],
          parentPath: creatingFolderParentPath
        });

        // Refresh folder list from backend
        await fetchBackendFolders();

        // Expand the parent folder so the new subfolder is visible
        if (creatingFolderParentPath) {
          setExpandedFolders((prev) => {
            const next = new Set(prev);
            next.add(creatingFolderParentPath);
            return next;
          });
        }

        // Reset state - must reset isSubmittingRef so subsequent create attempts
        // can be properly cancelled via blur/Escape
        setIsCreatingFolder(false);
        setNewFolderName('');
        setFolderError(null);
        setCreatingFolderParentPath(undefined);
        isSubmittingRef.current = false;
      } catch (err) {
        console.warn('[FolderCreate] Failed to create folder:', err);
        setFolderError('Failed');
        isSubmittingRef.current = false;
      }
    }, [newFolderName, folderList, creatingFolderParentPath, fetchBackendFolders, setExpandedFolders]);

    const handleFolderInputKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleCreateFolder();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          handleCancelCreateFolder();
        }
      },
      [handleCreateFolder, handleCancelCreateFolder]
    );

    // Drag-and-drop handlers
    const handleFolderDragOver = useCallback(
      (folderPath: string) => (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverTarget(folderPath);
      },
      []
    );

    // Client-side validation for folder drops (used in memo + drop handler)
    const isFolderDropValid = useCallback(
      (sourcePath: string, targetParentPath: string): boolean => {
        // Self-drop
        if (targetParentPath === sourcePath) return false;
        // Same parent = no-op
        const segments = sourcePath.split('/');
        const currentParent = segments.length <= 2
          ? NOTES_FOLDER_NAME
          : segments.slice(0, -1).join('/');
        if (currentParent === targetParentPath) return false;
        // Circular: target is descendant of source
        if (targetParentPath.startsWith(sourcePath + '/')) return false;
        // Depth check
        const targetDepth = targetParentPath.split('/').length;
        let maxSubtreeDepth = 0;
        for (const f of folderList) {
          if (f.path.startsWith(sourcePath + '/')) {
            const relDepth = f.path.split('/').length - segments.length;
            if (relDepth > maxSubtreeDepth) maxSubtreeDepth = relDepth;
          }
        }
        if (targetDepth + 1 + maxSubtreeDepth > 10) return false;
        // Name collision
        const folderName = segments[segments.length - 1];
        const newPath = `${targetParentPath}/${folderName}`;
        if (folderList.some((f) => f.path === newPath)) return false;
        return true;
      },
      [folderList]
    );

    // Derived validity: compute once per dragOverTarget change, not per dragOver event
    const isFolderDropTargetValid = useMemo(() => {
      if (!draggingFolderPath || !dragOverTarget || dragOverTarget === 'root') return true;
      return isFolderDropValid(draggingFolderPath, dragOverTarget);
    }, [draggingFolderPath, dragOverTarget, isFolderDropValid]);

    const handleFolderDragLeave = useCallback(() => {
      setDragOverTarget(null);
    }, []);

    const moveNoteToFolder = useCallback(
      async (noteId: string, targetFolderPath: string): Promise<void> => {
        const draggedNote = noteList.find((note) => note.id === noteId);
        if (!draggedNote) {
          return;
        }

        const previousFolderPath = draggedNote.folderPath ?? NOTES_FOLDER_NAME;
        const previousUpdatedAt = draggedNote.updatedAt;

        // Update the list immediately so folder moves don't wait on the
        // main-process note lock queue before rendering in the new section.
        store.set(syncNoteEntityAtom, {
          noteId,
          updates: {
            folderPath: targetFolderPath,
            updatedAt: nowInSeconds()
          }
        });

        try {
          const updatedNotes = await foldersApi.moveNotes.invoke({
            noteIds: [noteId],
            targetFolderPath
          });

          if (updatedNotes.length === 0) {
            store.set(syncNoteEntityAtom, {
              noteId,
              updates: {
                folderPath: previousFolderPath,
                updatedAt: previousUpdatedAt
              }
            });
            return;
          }

          for (const updated of updatedNotes) {
            store.set(syncNoteEntityAtom, {
              noteId: updated.id,
              updates: {
                folderPath: updated.folderPath,
                updatedAt: updated.updatedAt,
                ...(typeof updated.contentPath === 'string' ? { contentPath: updated.contentPath } : {})
              }
            });
          }

          await fetchBackendFolders();
        } catch (error) {
          store.set(syncNoteEntityAtom, {
            noteId,
            updates: {
              folderPath: previousFolderPath,
              updatedAt: previousUpdatedAt
            }
          });
          throw error;
        }
      },
      [fetchBackendFolders, noteList, store]
    );

    const moveFolderToParent = useCallback(
      async (sourcePath: string, targetParentPath: string): Promise<void> => {
        const sourceSegments = sourcePath.split('/');
        const folderName = sourceSegments[sourceSegments.length - 1];
        const newPath = `${targetParentPath}/${folderName}`;

        // Snapshot for revert
        const expandedSnapshot = store.get(expandedFoldersAtom);
        const activeFolderSnapshot = store.get(activeFolderPathAtom);
        const affectedNotes = noteList.filter(
          (n) => n.folderPath === sourcePath || n.folderPath?.startsWith(sourcePath + '/')
        );
        const noteSnapshots = affectedNotes.map((n) => ({
          id: n.id,
          folderPath: n.folderPath ?? NOTES_FOLDER_NAME
        }));

        // Optimistic update: remap expanded folders
        setExpandedFolders((prev) => {
          const next = new Set<string>();
          for (const p of prev) {
            if (p === sourcePath) next.add(newPath);
            else if (p.startsWith(sourcePath + '/')) next.add(newPath + p.slice(sourcePath.length));
            else next.add(p);
          }
          return next;
        });

        // Optimistic update: remap active folder path
        if (activeFolderSnapshot === sourcePath || activeFolderSnapshot.startsWith(sourcePath + '/')) {
          const remapped = activeFolderSnapshot === sourcePath
            ? newPath
            : newPath + activeFolderSnapshot.slice(sourcePath.length);
          setActiveFolderPath(remapped);
        }

        // Optimistic update: remap note folderPaths
        for (const note of affectedNotes) {
          const updatedFolderPath = note.folderPath === sourcePath
            ? newPath
            : newPath + (note.folderPath ?? NOTES_FOLDER_NAME).slice(sourcePath.length);
          store.set(syncNoteEntityAtom, {
            noteId: note.id,
            updates: { folderPath: updatedFolderPath }
          });
        }

        try {
          await foldersApi.moveFolder.invoke({
            sourcePath,
            targetParentPath
          });
          await fetchBackendFolders();
        } catch (err) {
          // Revert expanded folders
          setExpandedFolders(expandedSnapshot);
          // Revert active folder
          setActiveFolderPath(activeFolderSnapshot);
          // Revert note folderPaths
          for (const snap of noteSnapshots) {
            store.set(syncNoteEntityAtom, {
              noteId: snap.id,
              updates: { folderPath: snap.folderPath }
            });
          }
          await fetchBackendFolders();
          console.error('[DragDrop] Failed to move folder:', err);
        }
      },
      [fetchBackendFolders, noteList, store, setExpandedFolders, setActiveFolderPath]
    );

    const handleFolderDrop = useCallback(
      (targetPath: string) => async (e: React.DragEvent) => {
        e.preventDefault();

        // Check for folder drop first
        const folderPath = e.dataTransfer.getData('application/x-moss-folder');
        if (folderPath) {
          setDragOverTarget(null);
          setDraggingFolderPath(null);
          if (!isFolderDropValid(folderPath, targetPath)) return;
          try {
            await moveFolderToParent(folderPath, targetPath);
          } catch (err) {
            console.error('[DragDrop] Failed to move folder:', err);
          }
          return;
        }

        // Otherwise, handle note drop
        const noteId = e.dataTransfer.getData('text/plain');
        if (!noteId) return;

        // Find the note to check its current folder
        const draggedNote = noteList.find((n) => n.id === noteId);
        if (draggedNote?.folderPath === targetPath) {
          // Already in this folder, reset state and skip
          setDragOverTarget(null);
          setDraggingNoteId(null);
          return;
        }

        setDragOverTarget(null);
        setDraggingNoteId(null);

        try {
          await moveNoteToFolder(noteId, targetPath);
        } catch (err) {
          console.error('[DragDrop] Failed to move note:', err);
        }
      },
      [moveNoteToFolder, moveFolderToParent, isFolderDropValid, noteList]
    );

    const handleRootDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Show drop feedback for notes inside a folder or folders not already at root
      if (draggingNoteId) {
        const draggedNote = noteList.find((n) => n.id === draggingNoteId);
        if (draggedNote && draggedNote.folderPath !== NOTES_FOLDER_NAME) {
          setDragOverTarget('root');
        }
      } else if (draggingFolderPath) {
        // Folder is already at root if it has exactly 2 segments (e.g., "Notes/Projects")
        const segments = draggingFolderPath.split('/');
        if (segments.length > 2) {
          setDragOverTarget('root');
        }
      }
    }, [draggingNoteId, draggingFolderPath, noteList]);

    const handleRootDragLeave = useCallback((e: React.DragEvent) => {
      // Only clear when leaving the container entirely, not when moving between children
      const container = e.currentTarget;
      const relatedTarget = e.relatedTarget as Node | null;
      if (!relatedTarget || !container.contains(relatedTarget)) {
        setDragOverTarget(null);
      }
    }, []);

    const handleRootDrop = useCallback(
      async (e: React.DragEvent) => {
        e.preventDefault();

        // Check for folder drop first
        const folderPath = e.dataTransfer.getData('application/x-moss-folder');
        if (folderPath) {
          setDragOverTarget(null);
          setDraggingFolderPath(null);
          // Only move if not already at root
          const segments = folderPath.split('/');
          if (segments.length <= 2) return; // already at root
          if (!isFolderDropValid(folderPath, NOTES_FOLDER_NAME)) return;
          try {
            await moveFolderToParent(folderPath, NOTES_FOLDER_NAME);
          } catch (err) {
            console.error('[DragDrop] Failed to move folder to root:', err);
          }
          return;
        }

        const noteId = e.dataTransfer.getData('text/plain');
        if (!noteId) return;

        // Check if already at root
        const draggedNote = noteList.find((n) => n.id === noteId);
        if (draggedNote?.folderPath === NOTES_FOLDER_NAME) {
          setDragOverTarget(null);
          setDraggingNoteId(null);
          return;
        }

        setDragOverTarget(null);
        setDraggingNoteId(null);

        try {
          await moveNoteToFolder(noteId, NOTES_FOLDER_NAME);
        } catch (err) {
          console.error('[DragDrop] Failed to move note to root:', err);
        }
      },
      [moveNoteToFolder, moveFolderToParent, isFolderDropValid, noteList]
    );

    // Render a single note item
    const handleShowInFinder = useCallback((noteId: string) => {
      notesApi.showInFinder.invoke(noteId).catch((err) => {
        console.warn('[NotesListPanel] Failed to show in Finder:', err);
      });
    }, []);

    const removeNoteEntity = useSetAtom(removeNoteEntityAtom);

    const handleCloseExternalNote = useCallback(async (noteId: string) => {
      try {
        await externalNotesApi.close.invoke(noteId);
        removeNoteEntity(noteId);
      } catch (err) {
        console.warn('[NotesListPanel] Failed to close external note:', err);
      }
    }, [removeNoteEntity]);

    // Placeholder toggle pin handler — actual IPC wiring is in S5/Task 10
    const handleTogglePin = useCallback(async (noteId: string) => {
      const note = store.get(noteEntityAtom(noteId));
      if (!note) return;
      const nowSec = nowInSeconds();
      const willPin = !note.pinned;
      // Optimistic update
      store.set(syncNoteEntityAtom, {
        noteId,
        updates: {
          pinned: willPin,
          pinnedAt: willPin ? nowSec : null
        }
      });
      try {
        await notesApi.update.invoke(noteId, {
          pinned: willPin,
          pinnedAt: willPin ? nowSec : null
        });
      } catch (err) {
        // Revert on failure
        store.set(syncNoteEntityAtom, {
          noteId,
          updates: {
            pinned: note.pinned ?? false,
            pinnedAt: note.pinnedAt ?? null
          }
        });
        console.warn('[NotesListPanel] Failed to toggle pin:', err);
      }
    }, [store]);

    const handleCopyLink = useCallback(async (noteId: string, noteTitle: string) => {
      try {
        const copied = await notesApi.copyLinkToClipboard.invoke(noteId, {
          noteTitle,
          surface: 'notes_list_context_menu',
        });
        if (copied) {
          return;
        }
        console.warn('[NotesListPanel] Rich note link copy returned false');
      } catch (err) {
        console.warn('[NotesListPanel] Failed to copy rich note link:', err);
      }
    }, []);

    const handleOpenInNewWindow = useCallback((noteId: string) => {
      void systemApi.createWindow.invoke({ noteId }).catch((err) => {
        console.warn('[NotesListPanel] Failed to open note in new window:', err);
      });
    }, []);

    const renderNoteItem = useCallback(
      (note: RenderableNoteListItem, options?: NoteItemOptions) => (
        <NoteListItemWithMenu
          key={note.id}
          note={note}
          options={options}
          activeCardRef={activeCardRef}
          agentBusyNoteIds={agentBusyNoteIds}
          draggingNoteId={draggingNoteId}
          handleSelectNote={handleSelectNote}
          handleTogglePin={handleTogglePin}
          handleOpenInNewWindow={handleOpenInNewWindow}
          openSplitTab={openSplitTab}
          handleCopyLink={handleCopyLink}
          handleShowInFinder={handleShowInFinder}
          handleCloseExternalNote={handleCloseExternalNote}
          onRenameNote={onRenameNote}
          onDuplicateNote={onDuplicateNote}
          onDeleteNote={onDeleteNote}
          isSearchActive={isSearchActive}
          panelRef={panelRef}
          setDraggingNoteId={setDraggingNoteId}
          setDragOverTarget={setDragOverTarget}
        />
      ),
      [activeCardRef, agentBusyNoteIds, draggingNoteId, handleSelectNote, handleTogglePin, isSearchActive, onDeleteNote, onDuplicateNote, onRenameNote, handleShowInFinder, handleCloseExternalNote, handleOpenInNewWindow, openSplitTab, handleCopyLink]
    );

    const handleTrashFolderClick = useCallback((folderPath: string) => {
      setTrashFolderTarget(folderPath);
    }, []);

    const handleTrashFolderConfirm = useCallback(async () => {
      if (!trashFolderTarget) return;
      try {
        await foldersApi.delete.invoke({
          path: trashFolderTarget,
          moveNotesTo: 'trash'
        });
        await fetchBackendFolders();
      } catch (err) {
        console.warn('[NotesListPanel] Failed to trash folder:', err);
      }
      setTrashFolderTarget(null);
    }, [trashFolderTarget, fetchBackendFolders]);

    const handleShowFolderInFinder = useCallback((folderPath: string) => {
      foldersApi.showInFinder.invoke(folderPath).catch((err) => {
        console.warn('[NotesListPanel] Failed to show folder in Finder:', err);
      });
    }, []);

    const renderFolderTree = useCallback(
      (folder: { name: string; path: string; noteCount: number; parentPath?: string; type?: 'system' }, depth = 0) => {
        const folderNotes = notesByFolder.get(folder.path) ?? [];
        const children = childFoldersByParent.get(folder.path) ?? [];
        const isExpanded = expandedFolders.has(folder.path);
        // Show inline subfolder creation input if creating inside this folder
        const showSubfolderInput = isCreatingFolder && creatingFolderParentPath === folder.path;
        // moss-multi seam: surfaced shares never offer folder mutations.
        const mutable = !hidden('new-folder') && !surfacedFolder(folder.path);
        const isFolderDraggable = mutable && folder.type !== 'system';

        return (
          <ContextMenu key={folder.path}>
          <ContextMenuTrigger asChild>
          <div>
          <FolderGroup
            name={folder.name}
            path={folder.path}
            noteCount={folder.noteCount}
            depth={depth}
            isDragOver={dragOverTarget === folder.path && (draggingNoteId != null || (draggingFolderPath != null && isFolderDropTargetValid))}
            onDragOver={mutable ? handleFolderDragOver(folder.path) : undefined}
            onDragLeave={handleFolderDragLeave}
            onDrop={mutable ? handleFolderDrop(folder.path) : undefined}
            draggable={isFolderDraggable}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-moss-folder', folder.path);
              e.dataTransfer.effectAllowed = 'move';
              setDraggingFolderPath(folder.path);
            }}
            onDragEnd={() => {
              setDraggingFolderPath(null);
              setDragOverTarget(null);
            }}
            isDragging={draggingFolderPath === folder.path}
            onFolderClick={() => setActiveFolderPath(folder.path)}
            onCreateSubfolder={mutable ? () => handleStartCreateFolder(folder.path) : undefined}
            onRename={mutable ? async (newName) => {
              await foldersApi.rename.invoke({
                currentPath: folder.path,
                newName
              });
              await fetchBackendFolders();
              const parentSegments = folder.path.split('/').slice(0, -1);
              const newPath = [...parentSegments, newName].join('/');
              const notesInFolder = noteList.filter((n) =>
                n.folderPath === folder.path || n.folderPath.startsWith(folder.path + '/')
              );
              for (const note of notesInFolder) {
                const updatedFolderPath = note.folderPath === folder.path
                  ? newPath
                  : newPath + note.folderPath.slice(folder.path.length);
                store.set(syncNoteEntityAtom, {
                  noteId: note.id,
                  updates: { folderPath: updatedFolderPath }
                });
              }
            } : undefined}
          >
            {/* Subfolder creation input */}
            {isExpanded && showSubfolderInput && (
              <div className="flex flex-col gap-sidebar-list-gap pb-1">
                <div className="flex w-full items-center gap-2 rounded-lg px-sidebar-row-x py-sidebar-row-y">
                  <Folder className="h-3.5 w-3.5 shrink-0 text-ink-faint/60" />
                  <input
                    ref={folderInputRef}
                    type="text"
                    value={newFolderName}
                    onChange={(e) => {
                      const val = e.target.value;
                      setNewFolderName(val);
                      if (val.includes('/')) {
                        setFolderError('/ is reserved as a path separator');
                      } else if (folderError) {
                        setFolderError(null);
                      }
                    }}
                    onKeyDown={handleFolderInputKeyDown}
                    onBlur={handleCancelCreateFolder}
                    placeholder="Subfolder name..."
                    className={[
                      'min-w-0 flex-1 rounded border bg-surface-raised-control px-2 py-1 text-caption text-ink-default placeholder:text-ink-faint/50 focus:outline-none focus:ring-1 focus:ring-ink-default/20',
                      folderError ? 'border-accent-terracotta' : 'border-border-subtle'
                    ].join(' ')}
                  />
                </div>
                {folderError && (
                  <span className="px-8 text-nano text-accent-terracotta">{folderError}</span>
                )}
              </div>
            )}
            {/* Nested subfolders */}
            {isExpanded && children.map((child) => renderFolderTree(child, depth + 1))}
            {/* Notes in this folder */}
            {isExpanded && folderNotes.map((note) =>
              renderNoteItem({
                id: note.id,
                title: note.title,
                updatedAt: note.updatedAt,
                contentType: note.contentType ?? 'empty',
                folderPath: note.folderPath ?? NOTES_FOLDER_NAME,
                externalFilePath: note.externalFilePath,
                pinned: note.pinned,
                pinnedAt: note.pinnedAt ?? null
              })
            )}
          </FolderGroup>
          </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {/* moss-multi seam: folder-menu (A§2.2: the folder "Share..." item slot) */}
            {mutable && <FolderMenuItems folderPath={folder.path} />}
            {/* moss-multi seam: hide-registry (A§9) */}
            {hidden('reveal-in-finder') ? null : (
            <ContextMenuItem onSelect={() => handleShowFolderInFinder(folder.path)}>
              <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
              <span>Open in Finder</span>
            </ContextMenuItem>
            )}
            {hidden('reveal-in-finder') || hidden('trash') ? null : <ContextMenuSeparator />}
            {hidden('trash') ? null : (
            <ContextMenuItem onSelect={() => handleTrashFolderClick(folder.path)}>
              <Trash2 className="h-3.5 w-3.5 text-accent-terracotta" />
              <span>Trash Folder</span>
            </ContextMenuItem>
            )}
          </ContextMenuContent>
          </ContextMenu>
        );
      },
      [notesByFolder, childFoldersByParent, expandedFolders, dragOverTarget, draggingNoteId, draggingFolderPath, isFolderDropTargetValid, handleFolderDragOver, handleFolderDragLeave, handleFolderDrop, setActiveFolderPath, handleStartCreateFolder, fetchBackendFolders, noteList, store, renderNoteItem, isCreatingFolder, creatingFolderParentPath, newFolderName, folderError, handleFolderInputKeyDown, handleCancelCreateFolder, handleTrashFolderClick, handleShowFolderInFinder]
    );

    const renderedNotes = useMemo(() => {
      if (!hasAnyNotes) {
        return (
          <div className="rounded-xl border border-dashed border-border-subtle bg-surface-raised-card p-4 text-sm text-ink-muted">
            Notes you create will appear here.
          </div>
        );
      }

      // Panel search shows IPC results (title + content matches).
      if (hasPanelSearchQuery) {
        if (ipcSearchResults.length > 0) {
          return (
            <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto pb-6">
              <div className="flex flex-col gap-sidebar-list-gap">
                {ipcSearchResults.map((result) => (
                  <div
                    key={result.id}
                    ref={result.id === selectedSearchNoteId ? selectedSearchCardRef : undefined}
                  >
                    <SearchResultNoteCard
                      result={result}
                      agentBusyNoteIds={agentBusyNoteIds}
                      draggingNoteId={draggingNoteId}
                      highlightQuery={searchQuery}
                      handleSelectNote={handleSelectNote}
                      panelRef={panelRef}
                      handleTogglePin={handleTogglePin}
                      handleOpenInNewWindow={handleOpenInNewWindow}
                      openSplitTab={openSplitTab}
                      handleCopyLink={handleCopyLink}
                      handleShowInFinder={handleShowInFinder}
                      handleCloseExternalNote={handleCloseExternalNote}
                      onRenameNote={onRenameNote}
                      onDuplicateNote={onDuplicateNote}
                      onDeleteNote={onDeleteNote}
                      isSelected={result.id === selectedSearchNoteId}
                      showActiveState={false}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        }
        // IPC still loading — show title matches as a preview
        if (filteredNotes.length > 0) {
          return (
            <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto pb-6">
              <div className="flex flex-col gap-sidebar-list-gap">
                {filteredNotes.map((note) => renderNoteItem(note, {
                  isSelected: note.id === selectedSearchNoteId,
                  selectedCardRef: selectedSearchCardRef,
                  showActiveState: false
                }))}
              </div>
            </div>
          );
        }
        // No title or content matches
        return (
          <div className="flex flex-col items-center gap-1.5 py-4 text-center">
            <SearchX className="h-5 w-5 text-ink-faint" aria-hidden />
            <span className="text-micro text-ink-muted">No notes match your search</span>
          </div>
        );
      }

      // When not searching, show grouped view: pinned (fixed) + folders (scroll) + notes (scroll)
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* PINNED section — fixed at top */}
          {pinnedNotes.length > 0 && (
            <div className="shrink-0 bg-surface-notes-list pb-1">
              {/* Pinned label — clickable to collapse */}
              <button
                type="button"
                onClick={() => setPinnedSectionExpanded((prev) => !prev)}
                className="group/pinned flex items-center gap-sidebar-row-gap px-sidebar-row-x pb-1 text-left"
                aria-expanded={pinnedSectionExpanded}
                aria-label={`Pinned section, ${pinnedNotes.length} ${pinnedNotes.length === 1 ? 'note' : 'notes'}`}
              >
                <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                  <Pin className="h-3.5 w-3.5 fill-ink-faint/20 text-ink-faint/60 [stroke-width:1.5]" />
                  <span className={`absolute -left-3 flex items-center justify-center transition-opacity ${pinnedSectionExpanded ? 'opacity-0 group-hover/pinned:opacity-100' : 'opacity-100'}`}>
                    {pinnedSectionExpanded
                      ? <ChevronDown className="h-2.5 w-2.5 text-ink-faint/60" />
                      : <ChevronRight className="h-2.5 w-2.5 text-ink-faint/60" />}
                  </span>
                </span>

                <span className="text-caption font-book text-ink-faint">
                  Pinned
                </span>
              </button>

              {/* Pinned notes list */}
              {pinnedSectionExpanded && (
                <div className="ml-sidebar-indent flex flex-col gap-sidebar-list-gap pl-2">
                  {pinnedNotes.map((note) =>
                    renderNoteItem(
                      {
                        id: note.id,
                        title: note.title,
                        updatedAt: note.updatedAt,
                        contentType: note.contentType ?? 'empty',
                        folderPath: note.folderPath ?? NOTES_FOLDER_NAME,
                        externalFilePath: note.externalFilePath,
                        pinned: note.pinned,
                        pinnedAt: note.pinnedAt ?? null
                      },
                      {
                        breadcrumb: (note.folderPath ?? NOTES_FOLDER_NAME) !== NOTES_FOLDER_NAME
                          ? (note.folderPath ?? '').replace(/^Notes\//, '')
                          : undefined,
                        draggable: false
                      }
                    )
                  )}
                </div>
              )}
              <div className="mx-sidebar-row-x mt-2 h-px bg-border-subtle/40" />
            </div>
          )}

          {/* Folders + notes — single scroll area */}
          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto pb-6">
            <div className="flex flex-col gap-sidebar-list-gap">
              <SystemFolderSection renderNoteItem={renderNoteItem} />

              {isCreatingFolder && !creatingFolderParentPath && (
                <div className="flex flex-col gap-sidebar-list-gap">
                  <div className="flex w-full items-center gap-2 rounded-lg px-sidebar-row-x py-sidebar-row-y">
                    <Folder className="h-4 w-4 shrink-0 text-ink-faint/60" />
                    <input
                      ref={folderInputRef}
                      type="text"
                      value={newFolderName}
                      onChange={(e) => {
                        const val = e.target.value;
                        setNewFolderName(val);
                        if (val.includes('/')) {
                          setFolderError('/ is reserved as a path separator');
                        } else if (folderError) {
                          setFolderError(null);
                        }
                      }}
                      onKeyDown={handleFolderInputKeyDown}
                      onBlur={handleCancelCreateFolder}
                      placeholder="Folder name..."
                      className={[
                        'min-w-0 flex-1 rounded border bg-surface-raised-control px-2 py-1 text-caption text-ink-default placeholder:text-ink-faint/50 focus:outline-none focus:ring-1 focus:ring-ink-default/20',
                        folderError ? 'border-accent-terracotta' : 'border-border-subtle'
                      ].join(' ')}
                    />
                  </div>
                  {folderError && (
                    <span className="px-8 text-nano text-accent-terracotta">{folderError}</span>
                  )}
                </div>
              )}

              <div>
                {topLevelFolders.map((folder) => renderFolderTree(folder))}
              </div>

              {/* Root notes with drop zone */}
              <div
                data-testid="root-notes-drop-zone"
                className={[
                  'min-h-drop-zone transition-colors',
                  dragOverTarget === 'root' ? 'bg-accent-brand/5' : ''
                ].join(' ')}
                onDragOver={handleRootDragOver}
                onDragLeave={handleRootDragLeave}
                onDrop={handleRootDrop}
              >
                <div className="flex flex-col gap-sidebar-list-gap">
                  {rootNotes.map((note) =>
                    renderNoteItem({
                      id: note.id,
                      title: note.title,
                      updatedAt: note.updatedAt,
                      contentType: note.contentType ?? 'empty',
                      folderPath: note.folderPath ?? NOTES_FOLDER_NAME,
                      externalFilePath: note.externalFilePath,
                      pinned: note.pinned,
                      pinnedAt: note.pinnedAt ?? null
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }, [
      hasAnyNotes,
      hasPanelSearchQuery,
      filteredNotes,
      folderList,
      topLevelFolders,
      notesByFolder,
      renderNoteItem,
      renderFolderTree,
      isCreatingFolder,
      creatingFolderParentPath,
      newFolderName,
      folderError,
      handleOpenDirectory,
      handleStartCreateFolder,
      handleCancelCreateFolder,
      handleFolderInputKeyDown,
      // Drag-and-drop dependencies
      draggingNoteId,
      dragOverTarget,
      noteList,
      handleFolderDragOver,
      handleFolderDragLeave,
      handleFolderDrop,
      handleRootDragOver,
      handleRootDragLeave,
      handleRootDrop,
      // Active folder tracking
      setActiveFolderPath,
      // Stable deps used in nested event handlers
      fetchBackendFolders,
      ipcSearchResults,
      searchQuery,
      selectedSearchNoteId,
      selectedSearchCardRef,
      agentBusyNoteIds,
      handleSelectNote,
      isSearchActive,
      // Pinned section dependencies
      pinnedNotes,
      pinnedSectionExpanded,
      setPinnedSectionExpanded,
      rootNotes,
      handleTogglePin,
      handleShowInFinder,
      handleCloseExternalNote,
      handleOpenInNewWindow,
      openSplitTab,
      handleCopyLink,
      onRenameNote,
      onDuplicateNote,
      onDeleteNote
    ]);

    const handleSortSelect = useCallback((mode: 'recent' | 'az') => {
      if (sortMode === mode) {
        setSortDirection(sortDirection === 'desc' ? 'asc' : 'desc');
      } else {
        setSortMode(mode);
        // Natural default: A→Z for alphabetical, newest-first for recent
        setSortDirection('asc');
      }
    }, [sortMode, sortDirection, setSortMode, setSortDirection]);

    const RecentsCaret = sortDirection === 'asc' ? ChevronDown : ChevronUp;
    const AlphaCaret = sortDirection === 'asc' ? ChevronUp : ChevronDown;
    const [sortOpen, setSortOpen] = useState(false);
    const [folderActionsOpen, setFolderActionsOpen] = useState(false);

    // recent: asc = newest first (b-a), desc = oldest first (a-b)
    // az: asc = A→Z, desc = Z→A
    const SortIcon = sortMode === 'recent'
      ? (sortDirection === 'asc' ? ClockArrowDown : ClockArrowUp)
      : (sortDirection === 'asc' ? ArrowUpAZ : ArrowDownZA);

    const sortTooltip = sortMode === 'recent'
      ? (sortDirection === 'asc' ? 'Sort: Newest first' : 'Sort: Oldest first')
      : (sortDirection === 'asc' ? 'Sort: A to Z' : 'Sort: Z to A');

    const sortDropdown = (
      <DropdownMenu open={sortOpen} onOpenChange={setSortOpen}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted data-[state=open]:bg-surface-note-hover/50 data-[state=open]:text-ink-muted focus-visible:outline-none"
                  aria-label={sortTooltip}
                >
                  <SortIcon className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {!sortOpen && <TooltipContent side="bottom" sideOffset={6}>{sortTooltip}</TooltipContent>}
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="min-w-0 w-max">
          <DropdownMenuItem
            className="gap-2 text-xs"
            onSelect={(e) => { e.preventDefault(); handleSortSelect('recent'); }}
          >
            {sortMode === 'recent'
              ? <RecentsCaret aria-hidden className="h-3.5 w-3.5" />
              : <span className="h-3.5 w-3.5" aria-hidden="true" />}
            Recents
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 text-xs"
            onSelect={(e) => { e.preventDefault(); handleSortSelect('az'); }}
          >
            {sortMode === 'az'
              ? <AlphaCaret aria-hidden className="h-3.5 w-3.5" />
              : <span className="h-3.5 w-3.5" aria-hidden="true" />}
            Alphabetical
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    return (
      <>
        <NotesListPanel
          ref={panelRef}
          className="flex h-full min-w-0 w-full"
          onCreateNote={onCreateNote}
          onCollapse={onCollapse}
          showTitle={false}
          sortContent={sortDropdown}
          // moss-multi seam: hide-registry (A§9): with "Open..." and "New Folder" both withheld the menu goes too
          topContent={!isCreatingFolder && !(hidden('open-directory') && hidden('new-folder')) ? (
            <DropdownMenu open={folderActionsOpen} onOpenChange={setFolderActionsOpen}>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted data-[state=open]:bg-surface-note-hover/50 data-[state=open]:text-ink-muted focus-visible:outline-none"
                        aria-label="Folder actions"
                      >
                        <Folder className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  {!folderActionsOpen && <TooltipContent side="bottom" sideOffset={6}>Folder actions</TooltipContent>}
                </Tooltip>
              </TooltipProvider>
              <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="min-w-0 w-max">
                {hidden('open-directory') ? null : (
                <DropdownMenuItem className="gap-2 text-xs" onSelect={() => handleOpenDirectory()}>
                  <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                  Open...
                </DropdownMenuItem>
                )}
                {hidden('new-folder') ? null : (
                <DropdownMenuItem className="gap-2 text-xs" onSelect={() => handleStartCreateFolder()}>
                  <FolderPlus className="h-3.5 w-3.5" aria-hidden />
                  New Folder
                </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined}
          showSearch={true}
          searchValue={searchQuery}
          onSearchChange={handleSearchChange}
          onSearchClear={handleSearchClear}
          onSearchExpandedChange={setIsSearchActive}
          onSearchArrowDown={handleSearchArrowDown}
          onSearchArrowUp={handleSearchArrowUp}
          onSearchEnter={handleSearchEnter}
          footerContent={footerContent}
        >
          {renderedNotes}
        </NotesListPanel>
        <ConfirmationDialog
          open={trashFolderTarget !== null}
          onOpenChange={(open) => { if (!open) setTrashFolderTarget(null); }}
          title="Trash folder?"
          description={`Move "${trashFolderTarget?.split('/').pop() ?? ''}" and all its notes to Trash?`}
          confirmLabel="Trash"
          variant="danger"
          onConfirm={handleTrashFolderConfirm}
        />
      </>
    );
  }
);

export const NotesListPanelContent = memo(NotesListPanelContentComponent);

export default NotesListPanelContent;
