// ported-from: packages/shared/src/components/ui/confirmation-dialog.tsx @ 762abb777
import { ReactNode, useRef } from 'react';
import { Dialog } from '@/components/primitives';
import { X } from 'lucide-react';
import { useNotePaneDialogPosition } from './use-note-pane-dialog-position';

interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string | ReactNode;
  description?: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  variant?: 'default' | 'danger';
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  collisionBoundary?: Element | null;
  // moss-multi seam: cancel-focus (A§10.6): destructive sign-out defaults to keeping unsynced work.
  cancelAutoFocus?: boolean;
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'default',
  confirmDisabled = false,
  cancelDisabled = false,
  collisionBoundary,
  cancelAutoFocus = false
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogPositionStyle = useNotePaneDialogPosition({
    open,
    maxWidthPx: 320,
    boundaryElement: collisionBoundary
  });

  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  const handleConfirmClick = () => {
    if (confirmDisabled) {
      return;
    }
    handleConfirm();
  };

  const confirmButtonVariant = variant === 'danger' ? 'danger' : 'default';
  const confirmButtonClass =
    confirmButtonVariant === 'danger'
      ? 'bg-accent-terracotta text-ink-on-accent hover:bg-accent-terracotta/90'
      : 'bg-accent-brand text-ink-on-accent hover:bg-accent-brand-pressed';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[120] bg-surface-modal-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          data-moss-modal-overlay="true"
        />
        <Dialog.Content
          role={cancelAutoFocus ? 'alertdialog' : undefined}
          onOpenAutoFocus={cancelAutoFocus ? (event) => { event.preventDefault(); cancelRef.current?.focus(); } : undefined}
          data-remote-web-surface-blocking-dialog="true"
          style={dialogPositionStyle}
          className="fixed left-1/2 top-1/2 z-[130] w-full max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-surface-linen px-5 py-4 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
        >
          <div className="flex items-start justify-between">
            <Dialog.Title className="text-sm font-semibold text-ink-default">{title}</Dialog.Title>
            <Dialog.Close className="rounded-full p-1 text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>
          {description ? (
            typeof description === 'string' ? (
              <Dialog.Description className="mt-2 text-xs text-ink-muted">
                {description}
              </Dialog.Description>
            ) : (
              <Dialog.Description asChild>
                <div className="mt-2 text-xs text-ink-muted">{description}</div>
              </Dialog.Description>
            )
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                ref={cancelRef}
                onClick={handleCancel}
                disabled={cancelDisabled}
                className="rounded-lg border border-border-subtle bg-surface-linen px-3 py-1.5 text-xs font-medium text-ink-default transition hover:bg-surface-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cancelLabel}
              </button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <button
                type="button"
                onClick={handleConfirmClick}
                disabled={confirmDisabled}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium text-ink-on-accent transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${confirmButtonClass}`}
              >
                {confirmLabel}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default ConfirmationDialog;
