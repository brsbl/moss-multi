// Folder controls in moss's notes list (T2.2; A§8 capabilities), read through moss-multi seams in
// NotesListPanelContent and App. Roles come from the listing, so a control is offered only when the server would allow
// it: each asks the folder or item it acts on, never the vault root's role (T3.B17).
import { can, noteCan } from './capabilities.ts';
import { getBridge, WORKSPACE } from './bridge/index.ts';

const ROOT = 'Notes';
const workspace = () => getBridge()?.[WORKSPACE];
const roleOf = (path: string): string | null => workspace()?.folderRole(path) ?? null;
/** A row from another vault, surfaced into this one: moves never cross vaults (api/folders.ts). */
const surfacedFolder = (path: string): boolean => workspace()?.surfacedFolder(path) ?? false;

/** Rename and nest a subfolder: editors and above. */
export const canEditFolder = (path: string): boolean => can(roleOf(path), 'edit');

/** Folder actions → New Folder at the active vault's root. */
export const canCreateFolder = (): boolean => canEditFolder(ROOT);

/** Where "+ Note" and Cmd/Ctrl+N create: the active folder, or the vault root when it is a system folder (moss's rule). */
export const noteTargetFolder = (activeFolderPath: string, folders: readonly { path: string; type?: string }[]): string =>
  folders.some((folder) => folder.path === activeFolderPath && folder.type === 'system') ? ROOT : activeFolderPath;

/** "+ Note" and Cmd/Ctrl+N: editors and above on the folder the note lands in, never a viewer link or an unknown role. */
export const canCreateNote = (folderPath: string): boolean => canEditFolder(folderPath);

/** Dragging a note: whoever manages it (A§8 manage), since a move changes who can open it. */
export const canMoveNote = (docId: string): boolean =>
  !(workspace()?.surfacedShared(docId) ?? false) && noteCan(docId, 'manage');

/** Dragging a folder: whoever manages it; the vault itself never moves. */
export const canMoveFolder = (path: string): boolean => path !== ROOT && !surfacedFolder(path) && can(roleOf(path), 'manage');

/** A drop target: a folder of this vault the caller may add to. Moss's own rules still refuse cycles and no-op drops. */
export const canDropInto = (path: string): boolean => !surfacedFolder(path) && canEditFolder(path);

/** Trash Folder: the owner only. */
export const canTrashFolder = (path: string): boolean => can(roleOf(path), 'manage');

/** What a refused folder change says; moss itself would show a bare "Failed". */
export const folderRefusal = (error: unknown): string =>
  error instanceof Error && error.message.trim() ? error.message : 'The folder couldn’t be changed. Try again.';
