// Folder controls in moss's notes list (T2.2; A§8 capabilities), read through moss-multi seams in
// NotesListPanelContent. Roles come from the listing, so a control is offered only when the server would allow it.
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { getBridge, WORKSPACE } from './bridge/index.ts';

const roleOf = (path: string): string | null => getBridge()?.[WORKSPACE].folderRole(path) ?? null;

/** Rename, nest a subfolder, move a folder and drop notes on it: editors and above. */
export const canEditFolder = (path: string): boolean => roleAtLeast(roleOf(path), 'editor');

/** Folder actions → New Folder at the active vault's root. */
export const canCreateFolder = (): boolean => canEditFolder('Notes');

/** Trash Folder: the owner only. */
export const canTrashFolder = (path: string): boolean => roleOf(path) === 'owner';

/** What a refused folder change says; moss itself would show a bare "Failed". */
export const folderError = (error: unknown): string =>
  error instanceof Error && error.message.trim() ? error.message : 'The folder couldn’t be changed. Try again.';
