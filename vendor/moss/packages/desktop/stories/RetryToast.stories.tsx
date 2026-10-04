// ported-from: packages/desktop/stories/RetryToast.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import { AlertTriangle } from 'lucide-react';

export const meta = {
  title: 'Components/ErrorToast'
};

const ErrorToast = ({ message }: { message: string }) => (
  <div className="pointer-events-none fixed top-8 left-1/2 z-50 -translate-x-1/2">
    <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-status-error-border/50 bg-status-error-surface/95 px-4 py-2.5 shadow-[0_-1px_6px_var(--surface-fn-rgba0000025),0_1px_6px_var(--ink-shadow-soft)] backdrop-blur-sm">
      <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-status-error-text/80" />
      <span className="text-xs text-status-error-text">{message}</span>
    </div>
  </div>
);

/** Toast shown when autosave fails to write the note content to disk. */
export const SaveFailed: Story = () => (
  <ErrorToast message="Failed to save changes. Your edits are safe in memory." />
);

/** Toast shown when a note rename fails. */
export const RenameFailed: Story = () => (
  <ErrorToast message="Unable to rename this note right now." />
);

/** Toast shown when note creation fails. */
export const CreateFailed: Story = () => (
  <ErrorToast message="Could not create note. Try again." />
);

/** Toast shown when note deletion fails. */
export const DeleteFailed: Story = () => (
  <ErrorToast message="Could not delete note. Try again." />
);

/** Toast shown when restoring a trashed note fails. */
export const RestoreFailed: Story = () => (
  <ErrorToast message="Could not restore note. Try again." />
);
