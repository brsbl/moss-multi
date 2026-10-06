// The one capability helper (A§8, T2.6): every moss menu and control the web offers asks it, through roles.ts, the
// same floors the server enforces. An unknown or not-yet-known role clears no floor, so it gets no actions.
// The read-only viewer (packages/viewer) loads this module too, so it stays free of the bridge and the session.
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { can, type Capability } from '@moss-multi/protocol/roles';
import { knownRole } from './access.ts';

export { can, type Capability };

/** A note-level action (sidebar row menu, top bar): the tab's role on the note. */
export const noteCan = (docId: string, capability: Capability): boolean => can(knownRole(docId), capability);

/**
 * A control inside an editor that writes the note (a block's Edit, Delete or Fullscreen header). A bound pane's body
 * is editable only at `edit` and while it can write (A§10), and the viewer's never is, so the editor's editability
 * is the role's answer for every block, re-read whenever it changes.
 */
export const useBlockCanEdit = (): boolean => useLexicalEditable();
