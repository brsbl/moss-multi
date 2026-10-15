// The outdated banner's Reload asks first while edits are unacked; the question belongs to the shell, as sign-out's does.
import { useSyncExternalStore } from 'react';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { answerReload, needsReloadConfirmation, subscribeReloadConfirmation } from '../reload-guard.ts';

export function ReloadConfirmation() {
  const open = useSyncExternalStore(subscribeReloadConfirmation, needsReloadConfirmation, () => false);
  return <ConfirmationDialog open={open} onOpenChange={next => { if (!next) answerReload(false); }}
    title="Some edits haven’t synced" description="This version of Moss can no longer sync them. Reloading now will discard unsynced edits in this window; cancel to keep them on screen."
    confirmLabel="Reload anyway" cancelLabel="Cancel" cancelAutoFocus variant="danger"
    onConfirm={() => answerReload(true)} onCancel={() => answerReload(false)} />;
}
