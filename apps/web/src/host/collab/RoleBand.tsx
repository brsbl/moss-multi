// A reader's access (T9.10), in Moss's bottom band (its Trash notice, CanvasAreaContent): a viewer or commenter is told
// they cannot edit, signed in or on a link, and the band follows the role. A key typed into a note body or title the
// role cannot edit is refused out loud through the one refusal notice, once per notice.
import {
  BODY_BINDING_ATTR, DOC_ID_ATTR, EDIT_MODE_ATTR, EDITOR_PANE_ATTR, ROLE_BAND_ATTR, TITLE_BINDING_ATTR,
} from '@moss-multi/protocol/dom-contract';
import type { Role } from '@moss-multi/protocol/roles';
import type { ReactNode } from 'react';
import { knownRole, useDocRole } from '../access.ts';
import { useAuthState } from '../auth.ts';
import { useHistoryOpen } from '../history/HistoryView.tsx';
import { refusalMessage, refuseInput } from '../refusal.ts';
import { signInToDoMore } from '../surfaces/ShareEntryPoints.tsx';
import { useTerminal } from './terminal.ts';

const LEAD: Partial<Record<Role, string>> = { viewer: 'View only.', commenter: 'Comment only.' };
const CANNOT_EDIT = "You can't edit this note.";

/** What a key aimed at a field the role cannot edit says. */
const REFUSED: Partial<Record<Role, string>> = {
  viewer: "You can view this note, but you can't edit it.",
  commenter: "You can comment on this note, but you can't edit it.",
};
const RENAME_REFUSED = 'Only an editor can rename this note.';

/** The band's lead for `docId`'s pane, or null when it shows none: not a reader, ended, or History open. */
export function useRoleBand(docId: string | null): string | null {
  const role = useDocRole(docId);
  const terminal = useTerminal(docId);
  const historyOpen = useHistoryOpen(docId);
  const lead = role ? LEAD[role] : undefined;
  return lead && terminal === null && !historyOpen ? lead : null;
}

/**
 * The band. A signed-out link visitor's holds "Sign in to do more" below 640 px, where the top bar's copy hides; from
 * 640 px up the top bar keeps it and the band says why.
 */
export function RoleBand({ docId }: { docId: string }): ReactNode {
  const lead = useRoleBand(docId);
  const signedOut = useAuthState().status === 'signed-out';
  if (!lead) return null;
  return (
    <div className="pointer-events-none absolute bottom-8 left-1/2 z-40 w-max max-w-[calc(100%-2rem)] -translate-x-1/2">
      <div {...{ [ROLE_BAND_ATTR]: '' }} className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border-subtle/50 bg-surface-raised-card px-4 py-2.5 shadow-floating backdrop-blur-sm">
        <span className="text-xs text-ink-muted">
          {lead}{' '}
          {signedOut ? (
            <>
              <button type="button" onClick={signInToDoMore} className="font-medium text-ink-default hover:text-ink-muted sm:hidden">
                Sign in to do more
              </button>
              <span className="hidden sm:inline">{CANNOT_EDIT}</span>
            </>
          ) : CANNOT_EDIT}
        </span>
      </div>
    </div>
  );
}

/** Fields of the page's own whose keys are theirs: a key typed there is never aimed at the note. */
const ELSEWHERE = 'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
const OPEN_LAYERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
const FIELD = `[${TITLE_BINDING_ATTR}], [${BODY_BINDING_ATTR}]`;

/** Where the last press landed: a closed field takes no focus, so a key after a click there targets the page. */
let pressed: EventTarget | null = null;

/** The pane's title or body a key or paste is aimed at: its target, else the last press, else the selection. */
function aimedField(target: EventTarget | null): HTMLElement | null {
  const last = pressed instanceof Node && pressed.isConnected ? pressed : null;
  for (const node of [target, last ?? document.getSelection()?.anchorNode ?? null]) {
    if (!(node instanceof Node)) continue;
    const el = node instanceof Element ? node : node.parentElement;
    const field = el?.closest<HTMLElement>(FIELD);
    if (field?.closest(`[${EDITOR_PANE_ATTR}]`)) return field;
  }
  return null;
}

/** The sentence for a key or paste aimed at `field`, or null when the field takes it or something else says why. */
function refusalFor(field: HTMLElement): string | null {
  const title = field.hasAttribute(TITLE_BINDING_ATTR);
  // Only a field open to read: a live one takes the key, and an opening or ended note says why elsewhere.
  if (field.getAttribute(title ? TITLE_BINDING_ATTR : BODY_BINDING_ATTR) !== 'readonly') return null;
  const pane = field.closest(`[${EDITOR_PANE_ATTR}]`);
  const docId = pane?.getAttribute(DOC_ID_ATTR);
  const role = docId ? knownRole(docId) : null;
  if (!role) return null;
  if (role === 'suggester') return title && pane?.getAttribute(EDIT_MODE_ATTR) === 'suggest' ? RENAME_REFUSED : null;
  // Editors and owners: Review's band already says editing is paused.
  return REFUSED[role] ?? null;
}

function refuseAimed(target: EventTarget | null): void {
  // Never over a notice on screen; the next refusal waits until it clears.
  if (refusalMessage()) return;
  const active = document.activeElement;
  const field = aimedField(target);
  if (!field) return;
  if (active instanceof HTMLElement && active !== document.body && !field.contains(active) && active.closest(ELSEWHERE)) return;
  if (target instanceof Element && !field.contains(target) && target.closest(ELSEWHERE)) return;
  if ([...document.querySelectorAll(OPEN_LAYERS)].some((el) => el.getClientRects().length > 0)) return;
  const text = refusalFor(field);
  if (text) refuseInput(text);
}

/** Printable keys, Enter, Backspace and Delete; never Space (readers scroll with it) or a key with Cmd, Ctrl or Alt. */
function typesText(event: KeyboardEvent): boolean {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  const { key } = event;
  return key === 'Enter' || key === 'Backspace' || key === 'Delete' || (key !== ' ' && [...key].length === 1);
}

let installs = 0;
let release: (() => void) | null = null;

/** Listens while any pane is mounted; returns the release. */
export function watchRefusedTyping(): () => void {
  installs += 1;
  if (installs === 1) {
    const onKey = (event: KeyboardEvent) => {
      if (typesText(event)) refuseAimed(event.target);
    };
    const onPaste = (event: ClipboardEvent) => refuseAimed(event.target);
    const onPress = (event: PointerEvent) => {
      pressed = event.target;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('pointerdown', onPress, true);
    release = () => {
      pressed = null;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('paste', onPaste, true);
      window.removeEventListener('pointerdown', onPress, true);
    };
  }
  return () => {
    installs -= 1;
    if (installs === 0) {
      release?.();
      release = null;
    }
  };
}
