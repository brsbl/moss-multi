// A trash whose acks did not arrive in 5 s asks first (A§10.6). The question belongs to the shell, as sign-out's does.
import { useSyncExternalStore } from 'react';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { TRASH_COPY } from '@moss-multi/protocol/retention';
import { answerTrash, needsTrashConfirmation, subscribeTrashConfirmation } from '../trash-guard.ts';

export function TrashConfirmation() {
  const open = useSyncExternalStore(subscribeTrashConfirmation, needsTrashConfirmation, () => false);
  return <ConfirmationDialog open={open} onOpenChange={next => { if (!next) answerTrash(false); }}
    title={TRASH_COPY.unsyncedTitle} description={TRASH_COPY.unsyncedBody}
    confirmLabel={TRASH_COPY.unsyncedConfirm} cancelLabel="Cancel" cancelAutoFocus variant="danger"
    onConfirm={() => answerTrash(true)} onCancel={() => answerTrash(false)} />;
}
