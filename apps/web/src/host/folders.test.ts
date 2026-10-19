// The notes list's create and move rules (T3.B17; A§8): "+ Note" and Cmd/Ctrl+N ask the folder the note would land
// in, and a drag asks the item's own manage and the destination's edit, as the server does (api/folders.ts), never the
// vault root's role. Rows from another vault (surfaced) never drag and never take a drop.
import { beforeEach, expect, it, vi } from 'vitest';
import { rememberRole } from './access.ts';

const listing = vi.hoisted(() => ({
  roles: new Map<string, string>(),
  surfacedDocs: new Set<string>(),
  surfacedFolders: new Set<string>(),
  docs: [] as { id: string; folderPath: string }[],
}));

vi.mock('./bridge/index.ts', () => {
  const WORKSPACE = Symbol('workspace');
  const bridge = {
    [WORKSPACE]: {
      folderRole: (path: string) => listing.roles.get(path) ?? null,
      surfacedShared: (id: string) => listing.surfacedDocs.has(id),
      surfacedFolder: (path: string) => [...listing.surfacedFolders].some((p) => path === p || path.startsWith(`${p}/`)),
      getSnapshot: () => ({ docs: listing.docs }),
    },
  };
  return { WORKSPACE, getBridge: () => bridge };
});

const { canCreateNote, canDropInto, canMoveFolder, canMoveNote, noteTargetFolder } = await import('./folders.ts');

beforeEach(() => {
  listing.roles.clear();
  listing.surfacedDocs.clear();
  listing.surfacedFolders.clear();
  listing.docs = [];
});

it('creates where the note would land: a vault viewer may add to a child folder they edit, an owner not to one they only view', () => {
  listing.roles.set('Notes', 'viewer');
  listing.roles.set('Notes/Open', 'editor');
  listing.roles.set('Notes/Closed', 'viewer');
  expect(canCreateNote('Notes/Open')).toBe(true);
  expect(canCreateNote('Notes/Closed')).toBe(false);
  expect(canCreateNote('Notes')).toBe(false);

  listing.roles.set('Notes', 'owner');
  listing.roles.set('Notes/Shared to me', 'viewer');
  expect(canCreateNote('Notes')).toBe(true);
  expect(canCreateNote('Notes/Shared to me')).toBe(false);
});

it('gives an unknown or unlisted folder no "+ Note"', () => {
  listing.roles.set('Notes', 'owner');
  listing.roles.set('Notes/Odd', 'superuser');
  expect(canCreateNote('Notes/Odd')).toBe(false);
  expect(canCreateNote('Notes/Gone')).toBe(false);
});

it('falls back from a system folder to the vault root, the one target "+ Note" and Cmd/Ctrl+N share', () => {
  const folders = [{ path: 'Notes/Inbox', type: 'system' as const }, { path: 'Notes/Plans' }];
  expect(noteTargetFolder('Notes/Inbox', folders)).toBe('Notes');
  expect(noteTargetFolder('Notes/Plans', folders)).toBe('Notes/Plans');
  expect(noteTargetFolder('Notes', folders)).toBe('Notes');
  listing.roles.set('Notes', 'viewer');
  listing.roles.set('Notes/Inbox', 'owner');
  expect(canCreateNote(noteTargetFolder('Notes/Inbox', folders)), 'a system folder creates at the root, so the root decides').toBe(false);
});

it('drags what the caller manages, whatever their role on the vault root', () => {
  listing.roles.set('Notes', 'viewer');
  listing.roles.set('Notes/Owned', 'owner');
  listing.roles.set('Notes/Owned/Sub', 'owner');
  listing.roles.set('Notes/Open', 'editor');
  rememberRole('owned-note', 'owner');
  rememberRole('open-note', 'editor');
  expect(canMoveNote('owned-note')).toBe(true);
  expect(canMoveFolder('Notes/Owned/Sub')).toBe(true);
  expect(canMoveFolder('Notes/Owned')).toBe(true);
  // An editor-only source never drags.
  expect(canMoveNote('open-note')).toBe(false);
  expect(canMoveFolder('Notes/Open')).toBe(false);
  // Nor does a note or folder whose role is unknown, nor the vault itself.
  rememberRole('odd-note', 'superuser');
  expect(canMoveNote('odd-note')).toBe(false);
  expect(canMoveNote('unlisted-note')).toBe(false);
  listing.roles.set('Notes', 'owner');
  expect(canMoveFolder('Notes')).toBe(false);
});

it('drops only into a folder the caller may edit', () => {
  listing.roles.set('Notes', 'viewer');
  listing.roles.set('Notes/Open', 'editor');
  listing.roles.set('Notes/Closed', 'viewer');
  listing.roles.set('Notes/Owned', 'owner');
  expect(canDropInto('Notes/Open')).toBe(true);
  expect(canDropInto('Notes/Owned')).toBe(true);
  expect(canDropInto('Notes/Closed')).toBe(false);
  expect(canDropInto('Notes'), 'nor the root of a vault they only view').toBe(false);
  expect(canDropInto('Notes/Gone')).toBe(false);
});

it('never moves across vaults: a surfaced row neither drags nor takes a drop', () => {
  listing.roles.set('Notes', 'owner');
  listing.roles.set('Notes/From Ada', 'owner');
  listing.roles.set('Notes/From Ada/Inner', 'owner');
  listing.surfacedFolders.add('Notes/From Ada');
  listing.surfacedDocs.add('ada-note');
  rememberRole('ada-note', 'owner');
  rememberRole('own-note', 'owner');
  // A note in a folder surfaced from Ada's vault is listed unsurfaced itself, and still never moves here.
  rememberRole('inner-note', 'owner');
  listing.docs = [{ id: 'own-note', folderPath: 'Notes' }, { id: 'inner-note', folderPath: 'Notes/From Ada/Inner' }];
  expect(canMoveNote('own-note')).toBe(true);
  expect(canMoveNote('ada-note')).toBe(false);
  expect(canMoveNote('inner-note')).toBe(false);
  expect(canMoveFolder('Notes/From Ada')).toBe(false);
  expect(canMoveFolder('Notes/From Ada/Inner')).toBe(false);
  expect(canDropInto('Notes/From Ada')).toBe(false);
  expect(canDropInto('Notes/From Ada/Inner')).toBe(false);
});
