// ported-from: packages/desktop/src/renderer/components/NoteBreadcrumb.tsx @ 762abb777
import { useAtomValue, useSetAtom } from 'jotai';
import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  activeNoteEntityAtom,
  externalFolderNavigateAtom,
  revealFolderPathAtom,
  type NoteEntity,
} from '@moss/shared';

const NOTES_FOLDER_NAME = 'Notes';

interface BreadcrumbSegment {
  label: string;
  folderPath: string;
  clickable: boolean;
  /** For external subfolder segments, the absolute filesystem path */
  externalPath?: string;
}

/**
 * Breadcrumb navigation displayed above the note title inside the canvas.
 * Shows "Folder Name > Note Title" for notes inside folders.
 * For external notes: "External > source root > subdir > ... > filename.md".
 * Hidden for root-level notes (folderPath === "Notes").
 */
export function NoteBreadcrumb({
  note: noteOverride,
  onNavigate,
}: {
  note?: NoteEntity | null;
  onNavigate?: () => void;
} = {}) {
  const activeNote = useAtomValue(activeNoteEntityAtom);
  const note = noteOverride ?? activeNote;
  const revealFolderPath = useSetAtom(revealFolderPathAtom);
  const setExternalFolderNavigate = useSetAtom(externalFolderNavigateAtom);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const segments = useMemo<BreadcrumbSegment[]>(() => {
    if (!note) return [];

    const folderPath = note.folderPath ?? NOTES_FOLDER_NAME;

    // Root-level notes: no breadcrumb
    if (folderPath === NOTES_FOLDER_NAME) return [];

    const isExternal = Boolean(note.externalFilePath) || folderPath === 'Notes/External';

    if (isExternal && note.externalFilePath) {
      const filePath = note.externalFilePath;
      // Files opened by the OS may not carry root metadata. Use their parent
      // directory as the root so they keep an External path breadcrumb.
      const rootPath = note.externalRootPath ?? filePath.replace(/[\\/][^\\/]+$/, '');
      const repoName = rootPath.split(/[\\/]+/).filter(Boolean).pop() ?? 'external';

      const result: BreadcrumbSegment[] = [
        { label: 'External', folderPath: 'Notes/External', clickable: true },
        { label: repoName, folderPath: folderPath, clickable: true, externalPath: rootPath },
      ];

      // Build subfolder segments from relative path between root and file
      if (rootPath && filePath.startsWith(rootPath)) {
        const relPath = filePath.slice(rootPath.length).replace(/^[\\/]+/, '');
        const parts = relPath.split(/[\\/]+/).filter(Boolean);
        // All parts except the last (filename) are subdirectories
        let currentPath = rootPath;
        const separator = rootPath.includes('\\') ? '\\' : '/';
        for (let i = 0; i < parts.length - 1; i++) {
          currentPath = currentPath + separator + parts[i];
          result.push({
            label: parts[i],
            folderPath: '',
            clickable: true,
            externalPath: currentPath,
          });
        }
        // Last part is the filename (non-clickable)
        const fileName = parts[parts.length - 1] ?? note.title;
        result.push({ label: fileName, folderPath: '', clickable: false });
      } else {
        // Fallback: just show filename
        const fileName = filePath.split(/[\\/]+/).pop() ?? note.title;
        result.push({ label: fileName, folderPath: '', clickable: false });
      }

      return result;
    }

    // Regular folder note: build segments from folder path
    // folderPath is like "Notes/Projects" or "Notes/Projects/Q1"
    const parts = folderPath.split('/');
    const folderSegments: BreadcrumbSegment[] = [];

    // Skip the "Notes" prefix, build clickable folder segments
    for (let i = 1; i < parts.length; i++) {
      const partialPath = parts.slice(0, i + 1).join('/');
      folderSegments.push({
        label: parts[i],
        folderPath: partialPath,
        clickable: true,
      });
    }

    // Append the note title as the final non-clickable segment
    folderSegments.push({
      label: note.title || 'Untitled',
      folderPath: '',
      clickable: false,
    });

    return folderSegments;
  }, [note]);

  const handleSegmentClick = useCallback(
    (segment: BreadcrumbSegment) => {
      // Expand notes panel if hidden
      onNavigate?.();

      if (segment.externalPath) {
        // External folder: signal ExternalNotesList to expand and scroll
        revealFolderPath('Notes/External');
        setExternalFolderNavigate(segment.externalPath);
        return;
      }

      const { folderPath } = segment;
      revealFolderPath(folderPath);

      // Delay scroll to allow panel expansion and folder tree to render
      flashTimerRef.current = setTimeout(() => {
        const folderName = folderPath.split('/').pop();
        if (!folderName) return;
        const allLabels = document.querySelectorAll('[aria-label]');
        for (const el of allLabels) {
          const label = el.getAttribute('aria-label') ?? '';
          if (label.startsWith(`${folderName} folder`)) {
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            (el as HTMLElement).classList.add('bg-border-subtle/60');
            (el as HTMLElement).style.transition = 'background-color 0.6s';
            flashTimerRef.current = setTimeout(() => {
              (el as HTMLElement).classList.remove('bg-border-subtle/60');
              // Scroll the active note into view in the sidebar
              const notesPanel = el.closest('[data-notes-panel]') ?? document;
              const activeNote = notesPanel.querySelector('[data-note-active]') as HTMLElement | null;
              if (activeNote) {
                activeNote.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
              flashTimerRef.current = null;
            }, 400);
            break;
          }
        }
      }, onNavigate ? 300 : 150);
    },
    [revealFolderPath, setExternalFolderNavigate, onNavigate]
  );

  if (segments.length === 0) return null;

  return (
    <nav
      aria-label="Note location"
      className="flex min-w-0 items-center gap-0.5 overflow-hidden text-xs text-ink-faint"
    >
      {segments.map((segment, idx) => (
        <span key={`${segment.folderPath || segment.externalPath || segment.label}-${idx}`} className="flex min-w-0 shrink items-center gap-0.5">
          {idx > 0 && (
            <ChevronRight aria-hidden className="h-3 w-3 shrink-0 opacity-30" />
          )}
          {segment.clickable ? (
            <button
              type="button"
              onClick={() => handleSegmentClick(segment)}
              className="max-w-40 truncate rounded px-0.5 opacity-50 transition-colors hover:opacity-100 hover:text-ink-muted hover:bg-accent-brand/5"
              title={segment.label}
            >
              {segment.label}
            </button>
          ) : (
            <span className="max-w-48 truncate opacity-50" title={segment.label}>{segment.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
