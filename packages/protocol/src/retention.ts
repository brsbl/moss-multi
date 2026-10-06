// Trash copy (PRODUCT Notes; L§4.8 retention copy): the one module that says how long trash keeps something. Delete
// is a soft delete restorable for 30 days, a minimum rather than a deadline, so no copy counts days down or says
// "forever". Every surface that speaks about a trash reads its words here (retention.test.ts enumerates them).

export const RETENTION_DAYS = 30;

const restorable = `for ${RETENTION_DAYS} days`;

export const TRASH_COPY = {
  /** The trash list with nothing in it. */
  emptyTrash: `Notes you move to Trash can be restored ${restorable}.`,
  /** A trashed note open in its owner's trash view. */
  trashedNote: `This note is in Trash. You can restore it ${restorable}.`,
  /** A collaborator's open copy of a note its owner moved to Trash. */
  peerTrashed: 'This note was moved to Trash.',
  /** Confirming a folder's trash. */
  trashFolder: (name: string) => `Move "${name}" and all its notes to Trash? You can restore them ${restorable}.`,
  /** The bounded wait for acks ran out before a trash (A§10.6). */
  unsyncedTitle: 'Some edits haven’t synced',
  unsyncedBody: 'Moving to Trash now will discard edits in this window that haven’t reached the server. Cancel to keep editing and wait for the connection to return.',
  unsyncedConfirm: 'Move to Trash anyway',
} as const;

/** What every trash request answers besides its ids: the CLI's JSON action and the API's DELETE bodies. */
export const TRASHED_ACTION = { action: 'trashed', restorable: true, retentionDays: RETENTION_DAYS } as const;
