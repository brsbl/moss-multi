// ported-from: packages/desktop/src/renderer/prompt/ContextFilePills.tsx @ 762abb777
import { FileText, Folder, X } from 'lucide-react';
import type { ContextFile } from '@moss/shared';

export interface ContextFilePillsProps {
  /** Selected context files */
  files: ContextFile[];
  /** Callback to remove a file */
  onRemove: (path: string) => void;
  /** Whether the pills are disabled */
  disabled?: boolean;
}

/**
 * Displays selected context files as removable pills.
 * Used in the prompt area to show which files will be included in context.
 */
export const ContextFilePills = ({ files, onRemove, disabled = false }: ContextFilePillsProps) => {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 pb-2" role="group" aria-label="Selected context files">
      {files.map((file) => (
        <div
          key={file.path}
          className="group flex items-center gap-1 rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-default transition-colors hover:bg-ink-default/10"
          title={file.path}
        >
          {file.type === 'directory' ? (
            <Folder className="h-2.5 w-2.5 fill-file-link-primary/20 text-file-link-primary" strokeWidth={1.5} />
          ) : (
            <FileText className="h-2.5 w-2.5 text-file-link-primary" />
          )}
          <span className="max-w-24 truncate">{file.name}</span>
          <button
            type="button"
            onClick={() => onRemove(file.path)}
            disabled={disabled}
            className="ml-0.5 p-0.5 rounded-full hover:bg-accent-brand/20 transition-colors disabled:opacity-50"
            aria-label={`Remove ${file.name} from context`}
          >
            <X className="w-2.5 h-2.5 text-ink-muted group-hover:text-ink-default" />
          </button>
        </div>
      ))}
    </div>
  );
};

export default ContextFilePills;
