// Folder controls in moss's notes list (T2.2; A§8 capabilities), read through moss-multi seams in
// NotesListPanelContent. Roles come from the listing, so a control is offered only when the server would allow it.
import { can, roleAtLeast } from '@moss-multi/protocol/roles';
import { knownRole } from './access.ts';
import { getBridge, WORKSPACE } from './bridge/index.ts';

const roleOf = (path: string): string | null => getBridge()?.[WORKSPACE].folderRole(path) ?? null;

/** Rename and nest a subfolder: editors and above. */
export const canEditFolder = (path: string): boolean => roleAtLeast(roleOf(path), 'editor');

/** Folder actions → New Folder at the active vault's root. */
export const canCreateFolder = (): boolean => canEditFolder('Notes');

/** Dragging a note or folder to move it: the vault's owner only, since a move changes who can open it (A§8 manage).
 * A note also needs manage on itself: a folder shared into the caller's own Home holds notes they only edit. */
export const canMoveItems = (docId?: string): boolean =>
  can(roleOf('Notes'), 'manage') && (docId === undefined || can(knownRole(docId), 'manage'));

/** Trash Folder: the owner only. */
export const canTrashFolder = (path: string): boolean => roleOf(path) === 'owner';

/** What a refused folder change says; moss itself would show a bare "Failed". */
export const folderRefusal = (error: unknown): string =>
  error instanceof Error && error.message.trim() ? error.message : 'The folder couldn’t be changed. Try again.';
