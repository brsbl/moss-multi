// ported-from: packages/desktop/src/renderer/editor/plugins/FileLinkTypeaheadPlugin.tsx @ 762abb777
import { useCallback, useMemo } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  TextNode,
  type LexicalEditor
} from 'lexical';
import { $isHeadingNode } from '@lexical/rich-text';
import { FileText, Calendar, Folder, Hash } from 'lucide-react';

import { $createFileLinkNode } from '../nodes/FileLinkNode';
import { stripWikiLinks } from '../../../common/utils';
import { notesApi } from '../../api/electron';
import type { HeadingInfo, NoteSearchResult } from '../../../common/noteTypes';
import { useTypeahead, TypeaheadMenu, type TypeaheadItem } from '../typeahead';

// Mode determines what the typeahead is currently searching for
type TypeaheadMode = 'note_search' | 'same_note_heading' | 'cross_note_heading';

const MENU_ITEM_HEIGHT = 52;
const HEADING_MENU_ITEM_HEIGHT = 40;

// Discriminated union for typeahead results
interface NoteTypeaheadItem extends TypeaheadItem {
  type: 'note';
  data: NoteSearchResult;
}

interface HeadingTypeaheadItem extends TypeaheadItem {
  type: 'heading';
  data: HeadingInfo & { noteId?: string; noteTitle?: string };
}

type FileLinkTypeaheadItem = NoteTypeaheadItem | HeadingTypeaheadItem;

/**
 * Collects all headings from the current editor state.
 * Used for same-note anchor link typeahead.
 *
 * Note: We only traverse top-level children because HeadingNode extends ElementNode
 * and cannot be nested inside other elements in Lexical's rich-text model.
 */
function collectHeadingsFromEditor(editor: LexicalEditor): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  editor.getEditorState().read(() => {
    const root = $getRoot();
    root.getChildren().forEach((child) => {
      if ($isHeadingNode(child)) {
        const tag = child.getTag(); // 'h1', 'h2', etc.
        const level = parseInt(tag.charAt(1), 10) as 1 | 2 | 3 | 4;
        const text = stripWikiLinks(child.getTextContent()).trim();
        if (text) {
          headings.push({ level, text });
        }
      }
    });
  });
  return headings;
}

function toHeadingTypeaheadItem(
  heading: HeadingInfo,
  index: number,
  noteId?: string,
  noteTitle?: string
): HeadingTypeaheadItem {
  return {
    type: 'heading',
    id: `heading-${index}-${heading.text}`,
    label: heading.text,
    icon: Hash,
    data: { ...heading, noteId, noteTitle }
  };
}

function toNoteTypeaheadItem(note: NoteSearchResult): NoteTypeaheadItem {
  return {
    type: 'note',
    id: note.id,
    label: note.title,
    icon: FileText,
    data: note
  };
}

function formatDate(timestamp?: number) {
  if (!timestamp) return null;
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Determines the typeahead mode based on the query.
 * - '#...' → same_note_heading (e.g., [[#Intro]])
 * - 'NoteTitle#...' → cross_note_heading (e.g., [[My Note#Section]])
 * - anything else → note_search (e.g., [[My Note]])
 */
function determineMode(query: string): { mode: TypeaheadMode; noteTitle?: string; headingFilter: string } {
  // Same-note heading: query starts with #
  if (query.startsWith('#')) {
    return { mode: 'same_note_heading', headingFilter: query.slice(1) };
  }

  // Check for cross-note heading: contains # after a note title
  const hashIndex = query.indexOf('#');
  if (hashIndex !== -1) {
    const noteTitle = query.slice(0, hashIndex);
    const headingFilter = query.slice(hashIndex + 1);
    return { mode: 'cross_note_heading', noteTitle, headingFilter };
  }

  // Default: note search
  return { mode: 'note_search', headingFilter: '' };
}

export function FileLinkTypeaheadPlugin() {
  const [editor] = useLexicalComposerContext();

  // Single unified search handler that dispatches based on mode
  const handleSearch = useCallback(
    async (query: string): Promise<FileLinkTypeaheadItem[]> => {
      const { mode, noteTitle, headingFilter } = determineMode(query);

      // Same-note heading search
      if (mode === 'same_note_heading') {
        const headings = collectHeadingsFromEditor(editor);
        const lowerFilter = headingFilter.toLowerCase();
        return headings
          .filter((h) => h.text.toLowerCase().includes(lowerFilter))
          .map((h, i) => toHeadingTypeaheadItem(h, i));
      }

      // Cross-note heading search
      if (mode === 'cross_note_heading' && noteTitle) {
        try {
          // Find the note by title
          const matches = await notesApi.search.invoke({ query: noteTitle, limit: 5 });
          const exactMatch = matches.find(
            (m) => m.title.toLowerCase() === noteTitle.toLowerCase()
          );

          if (exactMatch) {
            // Found a matching note, fetch its headings
            const headings = await notesApi.getHeadings.invoke(exactMatch.id);
            const lowerFilter = headingFilter.toLowerCase();
            return headings
              .filter((h) => h.text.toLowerCase().includes(lowerFilter))
              .map((h, i) => toHeadingTypeaheadItem(h, i, exactMatch.id, exactMatch.title));
          }
        } catch {
          // Fall through to note search if resolution fails
        }
      }

      // Note search (default)
      try {
        const matches = await notesApi.search.invoke({ query, limit: 8 });
        return matches.map(toNoteTypeaheadItem);
      } catch {
        return [];
      }
    },
    [editor]
  );

  // Single unified select handler that dispatches based on item type
  const handleSelect = useCallback(
    (item: FileLinkTypeaheadItem, triggerOffset: number) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        if (!$isTextNode(anchorNode)) return;

        const textContent = anchorNode.getTextContent();
        const beforeTrigger = textContent.slice(0, triggerOffset);
        const afterCursor = textContent.slice(anchor.offset);

        let fileLinkNode;

        if (item.type === 'note') {
          // Regular wiki link to a note
          fileLinkNode = $createFileLinkNode(
            item.data.id,
            item.data.title,
            true, // isResolved
            null, // headingText
            'note_resolved' // resolutionState
          );
        } else if (item.type === 'heading') {
          const { noteId, noteTitle, text } = item.data;

          if (noteId && noteTitle) {
            // Cross-note anchor link
            fileLinkNode = $createFileLinkNode(
              noteId,
              noteTitle,
              true, // isResolved
              text, // headingText
              'fully_resolved' // resolutionState
            );
          } else {
            // Same-note anchor link
            fileLinkNode = $createFileLinkNode(
              null, // noteId - null for same-note
              '', // noteTitle - empty string (treated as same-note)
              true, // isResolved
              text, // headingText
              'fully_resolved' // resolutionState - same-note anchors are always resolved
            );
          }
        } else {
          return; // Unknown type
        }

        if (beforeTrigger.length === 0 && afterCursor.length === 0) {
          anchorNode.replace(fileLinkNode);
        } else {
          anchorNode.setTextContent(beforeTrigger);
          anchorNode.insertAfter(fileLinkNode);

          if (afterCursor.length > 0) {
            const afterNode = new TextNode(afterCursor);
            fileLinkNode.insertAfter(afterNode);
          }
        }

        // Add space after
        const spaceNode = new TextNode(' ');
        fileLinkNode.insertAfter(spaceNode);
        spaceNode.select();
      });

    },
    [editor]
  );

  const typeahead = useTypeahead<FileLinkTypeaheadItem>({
    trigger: {
      trigger: '[[',
      requireWordBoundary: false,
      completionChars: ']]'
    },
    onSearch: handleSearch,
    onSelect: handleSelect
  });

  // Compute current mode for rendering
  const currentMode = useMemo(
    () => determineMode(typeahead.query),
    [typeahead.query]
  );

  // Determine which item height to use based on results
  const itemHeight = useMemo(() => {
    if (typeahead.results.length === 0) return MENU_ITEM_HEIGHT;
    return typeahead.results[0].type === 'heading' ? HEADING_MENU_ITEM_HEIGHT : MENU_ITEM_HEIGHT;
  }, [typeahead.results]);

  // Cut off at ~60% of the last visible item to hint there's more to scroll
  const maxHeight = useMemo(() => {
    const fullItems = 3;
    const partialFraction = 0.6;
    return Math.floor(itemHeight * fullItems + itemHeight * partialFraction);
  }, [itemHeight]);

  // Get empty/no-results messages based on mode
  const messages = useMemo(() => {
    switch (currentMode.mode) {
      case 'same_note_heading':
        return {
          empty: 'Type to filter headings...',
          noResults: 'No headings found in this note'
        };
      case 'cross_note_heading':
        return {
          empty: `Headings in "${currentMode.noteTitle}"...`,
          noResults: `No headings found in "${currentMode.noteTitle}"`
        };
      default:
        return {
          empty: 'Type to search notes...',
          noResults: 'No matching notes found'
        };
    }
  }, [currentMode]);

  if (!typeahead.isOpen || !typeahead.position) {
    return null;
  }

  return (
    <TypeaheadMenu
      ref={typeahead.menuRef}
      items={typeahead.results}
      selectedIndex={typeahead.selectedIndex}
      position={typeahead.position}
      onSelect={typeahead.selectItem}
      onClose={typeahead.closeMenu}
      emptyQueryMessage={messages.empty}
      noResultsMessage={messages.noResults}
      isQueryEmpty={currentMode.mode === 'note_search' ? typeahead.query.length === 0 : currentMode.headingFilter.length === 0}
      itemHeight={itemHeight}
      maxHeight={maxHeight}
      renderItem={(item, isSelected, index) => {
        if (item.type === 'heading') {
          const heading = item.data;
          // Indent based on heading level (h1=0, h2=1, h3=2, h4=3)
          const indentLevel = heading.level - 1;
          const paddingLeft = 12 + indentLevel * 12; // base 12px + 12px per level

          return (
            <button
              type="button"
              data-index={index}
              className={[
                'flex w-full items-center gap-2 py-2 text-left text-small transition-colors',
                isSelected
                  ? 'bg-accent-brand/10 text-accent-brand-pressed'
                  : 'text-ink-default hover:bg-surface-panel hover:text-accent-brand-pressed'
              ].join(' ')}
              style={{ paddingLeft, paddingRight: 12 }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => typeahead.selectItem(item)}
            >
              <Hash className="h-4 w-4 flex-shrink-0" aria-hidden />
              <span className="truncate font-medium">{heading.text}</span>
              <span className="ml-auto text-micro text-ink-muted">H{heading.level}</span>
            </button>
          );
        }

        // Note item
        const note = item.data;
        return (
          <button
            type="button"
            data-index={index}
            className={[
              'flex w-full items-center gap-2 px-3 py-2 text-left text-small transition-colors',
              isSelected
                ? 'bg-accent-brand/10 text-accent-brand-pressed'
                : 'text-ink-default hover:bg-surface-panel hover:text-accent-brand-pressed'
            ].join(' ')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => typeahead.selectItem(item)}
          >
            <FileText className="h-4 w-4 flex-shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{note.title}</span>
              <div className="flex items-center gap-2 text-micro text-ink-muted">
                {note.folderPath && (
                  <span className="flex min-w-0 items-center gap-1">
                    <Folder className="h-3 w-3 flex-shrink-0" aria-hidden />
                    <span className="truncate">{note.folderPath}</span>
                  </span>
                )}
                {note.updatedAt && (
                  <span className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap">
                    <Calendar className="h-3 w-3" aria-hidden />
                    {formatDate(note.updatedAt)}
                  </span>
                )}
              </div>
            </div>
          </button>
        );
      }}
    />
  );
}

export default FileLinkTypeaheadPlugin;
