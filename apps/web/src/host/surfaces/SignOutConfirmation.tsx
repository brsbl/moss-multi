// The pending sign-out belongs to the shell, so closing Settings cannot strand it.
import { useSyncExternalStore } from 'react';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { answerSignOut, needsSignOutConfirmation, subscribeSignOutConfirmation } from '../sign-out-guard.ts';

export function SignOutConfirmation() {
  const open = useSyncExternalStore(subscribeSignOutConfirmation, needsSignOutConfirmation, () => false);
  return <ConfirmationDialog open={open} onOpenChange={next => { if (!next) answerSignOut(false); }}
    title="Some edits haven’t synced" description="Signing out now will discard unsynced edits in this window. Cancel to keep editing and wait for the connection to return."
    confirmLabel="Sign out anyway" cancelLabel="Cancel" cancelAutoFocus variant="danger"
    onConfirm={() => answerSignOut(true)} onCancel={() => answerSignOut(false)} />;
}
