// The web's entries in Moss's More actions (T9.30), after its own non-destructive groups and before Trash: Share…,
// Suggestions, Suggest changes and Version history, each offered only to whoever may use it. They are Moss's own menu
// rows inside its menu, so its keys, typeahead and focus return apply as they do to every row.
import { DropdownMenuItem, DropdownMenuSeparator } from '@moss/shared/components/ui/dropdown-menu';
import { HISTORY_BUTTON_ATTR } from '@moss-multi/protocol/dom-contract';
import { can } from '@moss-multi/protocol/roles';
import { FilePenLine, History, PencilLine, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useDocRole } from '../access.ts';
import { requestMode, useOpenSuggestions, useShownMode } from '../collab/suggest/mode.ts';
import { openSuggestion } from '../collab/suggest/SuggestionsPanel.tsx';
import { useTerminal } from '../collab/terminal.ts';
import { setHistoryOpen, useCanOpenHistory } from '../history/HistoryView.tsx';
import { openShare, useCanShare } from './ShareDialog.tsx';

const ROW = 'gap-2 text-xs';
const ICON = 'h-3.5 w-3.5';

/** Runs once the menu has closed and handed focus back to More actions, so what opens returns focus there. */
const afterClose = (run: () => void) => () => {
  setTimeout(run, 0);
};

export function NoteMenuItems({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  const open = useOpenSuggestions(docId);
  const terminal = useTerminal(docId);
  const canShare = useCanShare(docId);
  const canHistory = useCanOpenHistory(docId);
  if (role === null) return null;
  const canSuggest = can(role, 'edit') && mode === 'edit' && terminal === null;
  return (
    <>
      <DropdownMenuSeparator />
      {canShare ? (
        <DropdownMenuItem className={ROW} onSelect={afterClose(() => openShare({ type: 'doc', id: docId }))}>
          <UserPlus aria-hidden className={ICON} />
          Share…
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem className={ROW} onSelect={afterClose(() => openSuggestion(docId, null))}>
        <FilePenLine aria-hidden className={ICON} />
        Suggestions
        {open ? <>{' '}<span className="ml-auto pl-3 tabular-nums text-ink-faint">{open}</span></> : null}
      </DropdownMenuItem>
      {canSuggest ? (
        <DropdownMenuItem className={ROW} onSelect={afterClose(() => requestMode(docId, 'suggest'))}>
          <PencilLine aria-hidden className={ICON} />
          Suggest changes
        </DropdownMenuItem>
      ) : null}
      {canHistory && terminal === null ? (
        <DropdownMenuItem className={ROW} {...{ [HISTORY_BUTTON_ATTR]: '' }} onSelect={afterClose(() => setHistoryOpen(docId, true))}>
          <History aria-hidden className={ICON} />
          Version history
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
