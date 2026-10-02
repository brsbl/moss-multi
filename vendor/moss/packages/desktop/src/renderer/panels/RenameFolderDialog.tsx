// ported-from: packages/desktop/src/renderer/panels/RenameFolderDialog.tsx @ 762abb777
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@moss/shared/primitives';
import { Pencil, X } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { folderListAtom, useNotePaneDialogPosition } from '@moss/shared';
import { foldersApi } from '../api/electron';
import { DialogDimOverlay } from '../components/DialogDimOverlay';

const getParentFolderPath = (folderPath: string): string =>
  folderPath.split('/').slice(0, -1).join('/');

const getRenameFolderErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'Failed to rename folder';
  }

  const message = error.message.toLowerCase();
  if (message.includes('already exists')) {
    return 'A folder with this name already exists here';
  }
  if (message.includes('no longer exists') || message.includes('not found')) {
    return 'This folder no longer exists';
  }

  return error.message;
};

interface RenameFolderDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Called when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Current folder path */
  folderPath: string;
  /** Current folder name */
  currentName: string;
  /** Called when folder is renamed */
  onSuccess: () => void;
}

export function RenameFolderDialog({
  open,
  onOpenChange,
  folderPath,
  currentName,
  onSuccess
}: RenameFolderDialogProps) {
  const dialogPositionStyle = useNotePaneDialogPosition({ open, maxWidthPx: 384 });
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const folders = useAtomValue(folderListAtom);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setName(currentName);
      setError(null);
      setIsRenaming(false);
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [open, currentName]);

  const validate = useCallback(
    (value: string): string | null => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'Folder name cannot be empty';
      }
      if (trimmed.length > 100) {
        return 'Folder name is too long';
      }
      if (/[<>:"/\\|?*]/.test(trimmed)) {
        return 'Folder name contains invalid characters';
      }
      const parentPath = getParentFolderPath(folderPath);
      // Check for duplicate sibling name only (excluding current folder)
      const existingNames = folders
        .filter((f) => f.path !== folderPath && getParentFolderPath(f.path) === parentPath)
        .map((f) => f.name.toLowerCase());
      if (existingNames.includes(trimmed.toLowerCase())) {
        return 'A folder with this name already exists here';
      }
      return null;
    },
    [folders, folderPath]
  );

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setName(e.target.value);
      if (error) setError(null);
    },
    [error]
  );

  const handleRename = useCallback(async () => {
    const validationError = validate(name);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Don't rename if name hasn't changed
    if (name.trim() === currentName) {
      onOpenChange(false);
      return;
    }

    setIsRenaming(true);
    try {
      await foldersApi.rename.invoke({
        currentPath: folderPath,
        newName: name.trim()
      });
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(getRenameFolderErrorMessage(err));
    } finally {
      setIsRenaming(false);
    }
  }, [name, currentName, folderPath, validate, onSuccess, onOpenChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !isRenaming) {
        e.preventDefault();
        handleRename();
      }
    },
    [handleRename, isRenaming]
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogDimOverlay />
        <Dialog.Content
          data-remote-web-surface-blocking-dialog="true"
          style={dialogPositionStyle}
          className="fixed left-1/2 top-1/2 z-[130] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-surface-linen p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
        >
          <Dialog.Description className="sr-only">
            Rename this folder. The new name must be unique among sibling folders.
          </Dialog.Description>
          <div className="flex items-start justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-medium text-ink-default">
              <Pencil className="h-5 w-5 text-ink-muted" />
              Rename Folder
            </Dialog.Title>
            <Dialog.Close className="rounded-full p-1 text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted focus-visible:outline-none">
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>

          <div className="mt-4">
            <label htmlFor="folder-name" className="text-sm font-medium text-ink-muted">
              New name
            </label>
            <input
              ref={inputRef}
              id="folder-name"
              type="text"
              value={name}
              onChange={handleNameChange}
              onKeyDown={handleKeyDown}
              placeholder="Enter folder name..."
              disabled={isRenaming}
              className={[
                'mt-1.5 w-full rounded-lg border bg-surface-raised-control px-3 py-2 text-sm text-ink-default placeholder:text-ink-faint/50 focus:outline-none focus:ring-2 focus:ring-ink-default/20 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60',
                error ? 'border-accent-terracotta' : 'border-border-subtle'
              ].join(' ')}
            />
            {error && <p className="mt-1.5 text-micro text-accent-terracotta">{error}</p>}
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={isRenaming}
                className="rounded-lg border border-border-subtle bg-surface-linen px-4 py-2 text-sm font-medium text-ink-default transition hover:bg-surface-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleRename}
              disabled={isRenaming || name.trim().length === 0}
              className="rounded-lg bg-accent-brand px-4 py-2 text-sm font-medium text-ink-on-accent transition hover:bg-accent-brand-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRenaming ? 'Renaming...' : 'Rename'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default RenameFolderDialog;
