// ported-from: packages/desktop/src/renderer/components/DialogDimOverlay.tsx @ 762abb777
import { Dialog } from '@moss/shared/primitives';
import { cn } from '@moss/shared/lib/utils';

export const dialogDimOverlayClassName =
  'fixed inset-0 z-dialog-overlay bg-surface-modal-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0';

export function DialogDimOverlay({ className }: { className?: string }) {
  return (
    <Dialog.Overlay
      className={cn(dialogDimOverlayClassName, className)}
      data-moss-modal-overlay="true"
    />
  );
}
