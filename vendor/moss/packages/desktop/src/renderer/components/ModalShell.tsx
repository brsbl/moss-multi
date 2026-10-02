// ported-from: packages/desktop/src/renderer/components/ModalShell.tsx @ 762abb777
import type { ReactNode } from 'react';
import { useNotePaneDialogPosition } from '@moss/shared';
import { Dialog } from '@moss/shared/primitives';
import { X } from 'lucide-react';
import { DialogDimOverlay } from './DialogDimOverlay';

interface ModalShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  footer?: ReactNode;
  children: ReactNode;
}

export function ModalShell({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children
}: ModalShellProps) {
  const dialogPositionStyle = useNotePaneDialogPosition({ open, maxWidthPx: 480 });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogDimOverlay />
        <Dialog.Content
          data-remote-web-surface-blocking-dialog="true"
          style={dialogPositionStyle}
          className="fixed left-1/2 top-1/2 z-dialog-content flex max-h-modal w-full max-w-modal -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-linen shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
        >
          <Dialog.Description className="sr-only">{description}</Dialog.Description>
          <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
            <Dialog.Title className="text-micro font-medium uppercase tracking-wider text-ink-faint">{title}</Dialog.Title>
            <Dialog.Close className="rounded-full p-1 text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>
          <div className={`space-y-6 overflow-y-auto px-6 pt-2 ${footer ? 'pb-3' : 'pb-8'} [&::-webkit-scrollbar-thumb:hover]:bg-ink-default/20 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-ink-default/10 [&::-webkit-scrollbar-track]:bg-surface-transparent [&::-webkit-scrollbar]:w-1`}>
            {children}
          </div>
          {footer}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
