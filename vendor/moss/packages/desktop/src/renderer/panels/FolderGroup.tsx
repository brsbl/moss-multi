// ported-from: packages/desktop/src/renderer/panels/FolderGroup.tsx @ 762abb777
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Collapsible } from '@moss/shared/primitives';
import { Folder, FolderOpen, FolderPlus, type LucideIcon } from 'lucide-react';
import { atom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { expandedFoldersAtom, folderListAtom } from '@moss/shared';

/** Height of a folder header row in pixels — must match spacing.sidebar-folder-header in tailwind config. */
export const FOLDER_HEADER_HEIGHT_PX = 25;

interface FolderGroupProps {
  /** Folder display name */
  name: string;
  /** Full folder path (e.g., "Notes/Projects") */
  path: string;
  /** Number of notes in this folder */
  noteCount: number;
  /** Child note elements to render when expanded */
  children: ReactNode;
  /** Whether a note is being dragged over this folder */
  isDragOver?: boolean;
  /** Handler for drag over events on the folder header */
  onDragOver?: (e: React.DragEvent) => void;
  /** Handler for drag leave events on the folder header */
  onDragLeave?: (e: React.DragEvent) => void;
  /** Handler for drop events on the folder header */
  onDrop?: (e: React.DragEvent) => void;
  /** Handler for renaming the folder */
  onRename?: (newName: string) => Promise<void>;
  /** Handler called when folder is clicked/expanded (for active folder tracking) */
  onFolderClick?: () => void;
  /** Handler for creating a subfolder inside this folder */
  onCreateSubfolder?: () => void;
  /** Visual variant: 'system' uses grey icon */
  variant?: 'default' | 'system';
  /** Override the folder icon */
  icon?: LucideIcon;
  /** Extra content rendered next to the folder name (e.g., info tooltip) */
  nameExtra?: ReactNode;
  /** Compact mode: hide note count, reduce padding */
  compact?: boolean;
  /** Nesting depth for stacked sticky header offsets (0 = top-level) */
  depth?: number;
  /** Whether this folder header is draggable */
  draggable?: boolean;
  /** Handler for drag start on the folder header */
  onDragStart?: (e: React.DragEvent) => void;
  /** Handler for drag end on the folder header */
  onDragEnd?: (e: React.DragEvent) => void;
  /** Whether this folder is currently being dragged */
  isDragging?: boolean;
}

export function FolderGroup({
  name,
  path,
  noteCount,
  children,
  isDragOver = false,
  onDragOver,
  onDragLeave,
  onDrop,
  onRename,
  onFolderClick,
  onCreateSubfolder,
  variant = 'default',
  icon: IconOverride,
  nameExtra,
  compact = false,
  depth = 0,
  draggable: draggableProp = false,
  onDragStart,
  onDragEnd,
  isDragging = false
}: FolderGroupProps) {
  const isExpanded = useAtomValue(useMemo(() => atom((get) => get(expandedFoldersAtom).has(path)), [path]));
  const setExpandedFolders = useSetAtom(expandedFoldersAtom);
  const store = useStore();
  const isCollapsed = !isExpanded;

  // Inline rename state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const [editError, setEditError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select input when entering edit mode
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleToggle = useCallback(
    (open: boolean) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        if (open) {
          next.add(path);
        } else {
          next.delete(path);
        }
        // In both cases, collapse all descendant folders
        for (const p of prev) {
          if (p.startsWith(path + '/')) next.delete(p);
        }
        return next;
      });
      // Notify parent when folder is expanded (for active folder tracking)
      if (open) {
        onFolderClick?.();
      }
    },
    [path, setExpandedFolders, onFolderClick]
  );

  const handleNameClick = useCallback(
    (e: React.MouseEvent) => {
      // Only enter edit mode if folder is expanded and rename handler exists
      if (!isCollapsed && onRename) {
        e.stopPropagation();
        setIsEditing(true);
        setEditValue(name);
        setEditError(null);
      }
    },
    [isCollapsed, onRename, name]
  );

  const validateName = useCallback(
    (value: string): string | null => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return 'Name required';
      if (/[<>:"/\\|?*]/.test(trimmed)) return 'Invalid characters';
      // Read folder list imperatively — only needed at validation time, not reactively
      const folders = store.get(folderListAtom);
      const existingNames = folders
        .filter((f) => f.path !== path)
        .map((f) => f.name.toLowerCase());
      if (existingNames.includes(trimmed.toLowerCase())) return 'Already exists';
      return null;
    },
    [store, path]
  );

  const handleCancelEdit = useCallback(() => {
    if (isSubmitting) return;
    setIsEditing(false);
    setEditValue(name);
    setEditError(null);
  }, [isSubmitting, name]);

  const handleSubmitEdit = useCallback(async () => {
    const trimmed = editValue.trim();

    // No change - just close
    if (trimmed === name) {
      setIsEditing(false);
      return;
    }

    const error = validateName(editValue);
    if (error) {
      setEditError(error);
      return;
    }

    if (!onRename) return;

    setIsSubmitting(true);
    try {
      await onRename(trimmed);
      setIsEditing(false);
      setEditError(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setIsSubmitting(false);
    }
  }, [editValue, name, validateName, onRename]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmitEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleSubmitEdit, handleCancelEdit]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setEditValue(e.target.value);
      if (editError) setEditError(null);
    },
    [editError]
  );

  // Stacked sticky header: each depth level offsets by header height (32px)
  const stickyStyle: CSSProperties | undefined = !isCollapsed
    ? { top: depth * FOLDER_HEADER_HEIGHT_PX, zIndex: 10 - depth }
    : undefined;
  const FolderIcon = IconOverride ?? (isCollapsed ? Folder : FolderOpen);

  const getFolderIconClasses = () => {
    const color = variant === 'system' ? 'text-ink-faint/90' : 'text-ink-faint/60';
    const base = `h-4 w-4 shrink-0 ${color} [stroke-width:1.5]`;
    return noteCount > 0 ? `${base} fill-ink-faint/10` : `${base} fill-none`;
  };

  return (
    <Collapsible.Root open={!isCollapsed} onOpenChange={handleToggle}>
      {/* Folder header row */}
      <Collapsible.Trigger asChild>
        <div
          draggable={draggableProp && !isEditing}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          role="button"
          tabIndex={0}
          aria-label={`${name} folder, ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}, ${isCollapsed ? 'collapsed' : 'expanded'}`}
          style={stickyStyle}
          className={[
            `group/row flex h-sidebar-folder-header w-full cursor-pointer items-center gap-sidebar-row-gap px-sidebar-row-x py-sidebar-row-y text-left transition-colors`,
            isCollapsed ? 'rounded-lg' : 'sticky',
            isDragOver ? 'bg-accent-brand/5' : 'bg-surface-notes-list',
            'focus:outline-none',
            !isDragOver && 'hover:bg-surface-note-hover',
            isDragging && 'opacity-40'
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {/* Folder icon - filled if has notes, outline if empty */}
          <FolderIcon className={getFolderIconClasses()} />

          <div className="flex min-w-0 flex-1 items-center gap-1">
            {/* Folder name - clickable for rename when expanded */}
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={handleInputChange}
                onKeyDown={handleInputKeyDown}
                onBlur={handleCancelEdit}
                disabled={isSubmitting}
                onClick={(e) => e.stopPropagation()}
                className={[
                  'min-w-0 truncate rounded bg-surface-transparent px-1 -mx-1 text-caption font-book text-ink-faint placeholder:text-ink-faint/50 focus:outline-none focus:bg-surface-canvas/50',
                  editError ? 'ring-1 ring-accent-terracotta' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            ) : (
              <button
                type="button"
                onClick={handleNameClick}
                title={name}
                aria-label={!isCollapsed && onRename ? 'Click to rename folder' : undefined}
                className={[
                  'min-w-0 truncate text-left text-caption font-book text-ink-faint',
                  !isCollapsed && onRename && 'cursor-text hover:bg-surface-canvas/50 rounded px-1 -mx-1',
                  isDragOver && 'text-ink-default'
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {name}
              </button>
            )}

            {/* Note count - left aligned next to name */}
            {!compact && !isEditing && (
              <span className="shrink-0 text-micro font-light text-ink-faint/70">
                {noteCount}
              </span>
            )}
            {nameExtra}
          </div>

          {/* Create subfolder button - visible on hover */}
          {onCreateSubfolder && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreateSubfolder();
                    }}
                    className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-faint/60 opacity-0 transition-colors hover:text-ink-muted group-hover/row:opacity-100"
                    aria-label="Create subfolder"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Create subfolder</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content
        className="data-[state=open]:overflow-visible"
        role="region"
        aria-label={`Notes in ${name} folder`}
      >
        <div className={[
          'ml-sidebar-indent border-l border-border-clear pl-2 pt-0.5 transition-colors',
          isDragOver && 'bg-accent-brand/5'
        ].filter(Boolean).join(' ')}>
          <div className="flex flex-col gap-sidebar-list-gap">
            {children}
          </div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export default FolderGroup;
