// ported-from: packages/desktop/src/renderer/panels/TrashedNotesPanelContent.tsx @ 762abb777
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { ExternalLink, RotateCcw, SearchX } from 'lucide-react';
import {
  NotesListPanel,
  NoteCard,
  activeNoteIdAtom,
  trashedNotesEntityAtom,
  lastViewedNoteIdForViewAtom,
  type NotesListPanelHandle
} from '@moss/shared';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@moss/shared/components/ui/context-menu';
import type { NoteSearchResult } from '../../common/noteTypes';
import { formatRelativeTime } from './notesPanelUtils';
import { notesApi } from '../api/electron';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';

export type TrashedNotesPanelContentProps = {
  onSelectNote: (id: string) => void;
  onRestoreNote: (id: string) => void;
  onCollapse?: () => void;
  footerContent?: React.ReactNode;
};

export type TrashedNotesPanelContentHandle = {
  focusSearch: () => void;
};

type TrashedNoteContextMenuProps = {
  noteId: string;
  onRestoreNote: (id: string) => void;
  onShowInFinder: (id: string) => void;
  children: (isContextMenuOpen: boolean) => React.ReactNode;
};

function TrashedNoteContextMenu({
  noteId,
  onRestoreNote,
  onShowInFinder,
  children
}: TrashedNoteContextMenuProps) {
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);

  return (
    <ContextMenu onOpenChange={setIsContextMenuOpen}>
      <ContextMenuTrigger asChild>
        <div>{children(isContextMenuOpen)}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onRestoreNote(noteId)}>
          <RotateCcw className="h-3.5 w-3.5 text-ink-muted" />
          <span>Restore</span>
        </ContextMenuItem>
        {/* moss-multi seam: hide-registry (A§9) */}
        {hidden('reveal-in-finder') ? null : (
        <ContextMenuItem onSelect={() => onShowInFinder(noteId)}>
          <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
          <span>Open in Finder</span>
        </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const TrashedNotesPanelContent = forwardRef<TrashedNotesPanelContentHandle, TrashedNotesPanelContentProps>(
  function TrashedNotesPanelContent({ onSelectNote, onRestoreNote, onCollapse, footerContent }, ref) {
    const trashedNotes = useAtomValue(trashedNotesEntityAtom);
    const activeNoteId = useAtomValue(activeNoteIdAtom);
    const [lastViewedTrashedNoteId, setLastViewedTrashedNoteId] = useAtom(lastViewedNoteIdForViewAtom('trash'));
    const panelRef = useRef<NotesListPanelHandle>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isSearchFocused, setIsSearchFocused] = useState(false);

    // IPC content search state
    const [ipcSearchResults, setIpcSearchResults] = useState<NoteSearchResult[]>([]);
    const ipcSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useImperativeHandle(ref, () => ({
      focusSearch: () => {
        panelRef.current?.focusSearch();
      }
    }), []);

    const filteredNotes = useMemo(() => {
      const query = searchQuery.trim().toLowerCase();
      if (query === '') {
        return trashedNotes;
      }
      return trashedNotes.filter((note) =>
        note.title.toLowerCase().includes(query)
      );
    }, [trashedNotes, searchQuery]);

    const hasAnyNotes = trashedNotes.length > 0;
    const isSearching = searchQuery.trim() !== '';

    // Clean up pending debounce timer on unmount
    useEffect(() => {
      return () => {
        if (ipcSearchTimerRef.current) clearTimeout(ipcSearchTimerRef.current);
      };
    }, []);

    // IPC content search (debounced)
    const ipcSearchCounterRef = useRef(0);
    const runIpcSearch = useCallback(async (query: string) => {
      if (ipcSearchTimerRef.current) clearTimeout(ipcSearchTimerRef.current);
      if (!query.trim()) {
        setIpcSearchResults([]);
        return;
      }
      const requestId = ++ipcSearchCounterRef.current;
      ipcSearchTimerRef.current = setTimeout(async () => {
        try {
          const results = await notesApi.search.invoke({
            query,
            limit: 20,
            searchTrashed: true
          });
          if (ipcSearchCounterRef.current === requestId) {
            setIpcSearchResults(results);
          }
        } catch (err) {
          console.warn('[TrashedNotesPanel] IPC search failed:', err);
          if (ipcSearchCounterRef.current === requestId) {
            setIpcSearchResults([]);
          }
        }
      }, 150);
    }, []);

    // Reset selection when filtered results change
    useEffect(() => {
      setSelectedIndex(0);
    }, [filteredNotes.length, searchQuery]);

    const hasAutoSelectedRef = useRef(false);
    useEffect(() => {
      if (hasAutoSelectedRef.current) return;
      if (hasAnyNotes && lastViewedTrashedNoteId) {
        const noteExists = trashedNotes.some((note) => note.id === lastViewedTrashedNoteId);
        if (noteExists && activeNoteId !== lastViewedTrashedNoteId) {
          hasAutoSelectedRef.current = true;
          onSelectNote(lastViewedTrashedNoteId);
        }
      }
    }, [hasAnyNotes, trashedNotes, lastViewedTrashedNoteId, activeNoteId, onSelectNote]);

    const handleSelectNote = useCallback(
      (id: string) => {
        setLastViewedTrashedNoteId(id);
        onSelectNote(id);
      },
      [onSelectNote, setLastViewedTrashedNoteId]
    );

    const handleSearchChange = useCallback((value: string) => {
      setSearchQuery(value);
      void runIpcSearch(value);
    }, [runIpcSearch]);

    const handleSearchClear = useCallback(() => {
      setSearchQuery('');
      setSelectedIndex(0);
      setIpcSearchResults([]);
      if (ipcSearchTimerRef.current) clearTimeout(ipcSearchTimerRef.current);
    }, []);

    const handleShowInFinder = useCallback((noteId: string) => {
      notesApi.showInFinder.invoke(noteId).catch(console.warn);
    }, []);

    const renderNoteWithContextMenu = useCallback(
      (noteId: string, renderNoteCard: (isContextMenuOpen: boolean) => React.ReactNode) => (
        <TrashedNoteContextMenu
          key={noteId}
          noteId={noteId}
          onRestoreNote={onRestoreNote}
          onShowInFinder={handleShowInFinder}
        >
          {renderNoteCard}
        </TrashedNoteContextMenu>
      ),
      [onRestoreNote, handleShowInFinder]
    );

    // Use IPC results when searching and results are available; otherwise use title-filtered notes
    const navigableList = isSearching && ipcSearchResults.length > 0 ? ipcSearchResults : filteredNotes;

    const handleSearchArrowDown = useCallback(() => {
      if (navigableList.length === 0) return;
      setSelectedIndex((prev) => (prev + 1) % navigableList.length);
    }, [navigableList.length]);

    const handleSearchArrowUp = useCallback(() => {
      if (navigableList.length === 0) return;
      setSelectedIndex((prev) => (prev - 1 + navigableList.length) % navigableList.length);
    }, [navigableList.length]);

    const handleSearchEnter = useCallback(() => {
      if (navigableList.length > 0 && selectedIndex < navigableList.length) {
        const note = navigableList[selectedIndex];
        handleSelectNote(note.id);
        panelRef.current?.blurSearch();
      }
    }, [navigableList, selectedIndex, handleSelectNote]);

    const renderedNotes = useMemo(() => {
      if (!hasAnyNotes) {
        return (
          <div className="rounded-xl border border-dashed border-border-subtle bg-surface-raised-card p-4 text-sm text-ink-muted">
            Deleted notes stay here for 30 days before being removed forever.
          </div>
        );
      }

      // When searching, show IPC results (title + content matches)
      if (isSearching && ipcSearchResults.length > 0) {
        return (
          <div className="flex flex-col gap-2">
            {ipcSearchResults.map((result) =>
              renderNoteWithContextMenu(
                result.id,
                (isContextMenuOpen) => (
                  <NoteCard
                    id={result.id}
                    title={result.title}
                    updatedAt={result.updatedAt ?? 0}
                    formattedTime={result.updatedAt ? `Deleted ${formatRelativeTime(result.updatedAt)}` : ''}
                    isActive={result.id === activeNoteId}
                    isContextMenuOpen={isContextMenuOpen}
                    variant="trash"
                    snippet={result.snippet}
                    highlightQuery={searchQuery}
                    onSelect={(id) => {
                      handleSelectNote(id);
                      if (isSearchFocused) {
                        panelRef.current?.blurSearch();
                      }
                    }}
                  />
                )
              )
            )}
          </div>
        );
      }

      // Show title-filtered results while IPC is loading, or no-match state
      if (isSearching && filteredNotes.length === 0 && ipcSearchResults.length === 0) {
        return (
          <div className="flex flex-col items-center gap-1.5 py-5 text-center">
            <SearchX className="h-5 w-5 text-ink-faint" aria-hidden />
            <span className="text-micro text-ink-muted">No archived notes match your search</span>
          </div>
        );
      }

      // Default: show all trashed notes
      return (
        <div className="flex flex-col gap-2">
          {(isSearching ? filteredNotes : trashedNotes).map((note) =>
            renderNoteWithContextMenu(
              note.id,
              (isContextMenuOpen) => (
                <NoteCard
                  id={note.id}
                  title={note.title}
                  updatedAt={note.updatedAt}
                  formattedTime={note.trashedAt != null ? `Deleted ${formatRelativeTime(note.trashedAt)}` : 'Unknown'}
                  isActive={note.id === activeNoteId}
                  isContextMenuOpen={isContextMenuOpen}
                  variant="trash"
                  highlightQuery={isSearching ? searchQuery : undefined}
                  onSelect={(id) => {
                    handleSelectNote(id);
                    if (isSearchFocused) {
                      panelRef.current?.blurSearch();
                    }
                  }}
                />
              )
            )
          )}
        </div>
      );
    }, [activeNoteId, trashedNotes, filteredNotes, ipcSearchResults, handleSelectNote, hasAnyNotes, isSearching, isSearchFocused, searchQuery, renderNoteWithContextMenu]);

    return (
      <NotesListPanel
        ref={panelRef}
        className="flex h-full min-w-0 w-full"
        variant="trash"
        onCollapse={onCollapse}
        showSearch={true}
        alwaysExpandSearch={true}
        searchValue={searchQuery}
        searchPlaceholder="Search trash..."
        onSearchChange={handleSearchChange}
        onSearchClear={handleSearchClear}
        onSearchFocusChange={setIsSearchFocused}
        onSearchArrowDown={handleSearchArrowDown}
        onSearchArrowUp={handleSearchArrowUp}
        onSearchEnter={handleSearchEnter}
        showTitle={false}
        footerContent={footerContent}
      >
        {renderedNotes}
      </NotesListPanel>
    );
  }
);

export default TrashedNotesPanelContent;
