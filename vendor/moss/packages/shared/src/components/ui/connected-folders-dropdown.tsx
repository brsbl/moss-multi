// ported-from: packages/shared/src/components/ui/connected-folders-dropdown.tsx @ 762abb777
import { useCallback } from 'react';
import { Popover } from '@/components/primitives';
import { FolderOpen, Plus } from 'lucide-react';

interface AddContextPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allFolders: string[];
  enabledPaths: Set<string>;
  onToggle: (path: string, enabled: boolean) => void;
  onAddFolder: () => void;
  onInsertMention: () => void;
  children: React.ReactNode;
}

function folderDisplayName(fullPath: string): string {
  const parts = fullPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

export function AddContextPopover({
  open,
  onOpenChange,
  allFolders,
  enabledPaths,
  onToggle,
  onAddFolder,
  onInsertMention,
  children
}: AddContextPopoverProps) {
  const handleToggle = useCallback(
    (path: string, currentEnabled: boolean) => {
      onToggle(path, !currentEnabled);
    },
    [onToggle]
  );

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          positionerClassName="z-[140]"
          className="z-[140] w-64 rounded-lg bg-surface-floating shadow-lg ring-1 ring-border-default/5 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col py-1.5">
            {/* @ mention hint */}
            <button
              type="button"
              onClick={() => { onInsertMention(); onOpenChange(false); }}
              className="flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-canvas"
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-xs font-semibold text-ink-muted">@</span>
              <div className="min-w-0">
                <div className="text-xs font-medium text-ink-default">Mention a note or skill</div>
                <div className="text-nano text-ink-faint">Type @ in the prompt</div>
              </div>
            </button>

            {/* Divider */}
            <div className="mx-3 my-1.5 border-t border-border-subtle/60" />

            {/* Connected folders section */}
            <div className="px-3 pb-1">
              <div className="text-nano font-medium uppercase tracking-wider text-ink-faint/70">Always include</div>
              <div className="mt-0.5 text-nano text-ink-faint/60">Folders Moss can read every run</div>
            </div>

            {allFolders.length > 0 && (
              <div className="flex flex-col gap-0.5 px-2">
                {allFolders.map((path) => {
                  const enabled = enabledPaths.has(path);
                  return (
                    <label
                      key={path}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-surface-canvas"
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => handleToggle(path, enabled)}
                        className="h-3.5 w-3.5 rounded border-border-default accent-accent-brand"
                      />
                      <FolderOpen className="h-3 w-3 shrink-0 text-ink-faint" />
                      <span
                        className="flex-1 truncate text-xs text-ink-muted"
                        title={path}
                      >
                        {folderDisplayName(path)}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={onAddFolder}
              className="mx-2 mt-0.5 flex items-center gap-1.5 rounded px-1 py-1 text-nano text-ink-faint transition-colors hover:bg-surface-canvas hover:text-ink-muted"
            >
              <Plus className="h-3 w-3" />
              <span>Add folder...</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
