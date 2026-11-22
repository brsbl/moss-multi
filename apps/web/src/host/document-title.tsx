// The tab names what is being written (T9.31): "<note> — <vault> — Moss" for the focused pane's note, the vault left
// out for a link visitor and for a note the vault on screen does not list. With no note open the page's own title
// stands. It reads the note's live title, the breadcrumb's, so anyone's rename shows.
import { focusedNoteIdAtom } from '@moss/shared/state/atoms';
import { noteEntityAtom } from '@moss/shared/state/note-atoms';
import { atom, useAtomValue } from 'jotai';
import { useEffect, useMemo, useRef } from 'react';
import { useVaultOfNote } from './vault-name.ts';

const none = atom<object | null>(null);

export function DocumentTitle(): null {
  const id = useAtomValue(focusedNoteIdAtom);
  const note = useAtomValue(useMemo(() => (id ? noteEntityAtom(id) : none), [id]));
  const vault = useVaultOfNote(note ? id : null);
  const page = useRef<string | null>(null);
  const name = note ? ((note as { title?: unknown }).title ?? '') : null;
  const title = name === null ? null : [(typeof name === 'string' ? name.trim() : '') || 'Untitled', vault, 'Moss'].filter(Boolean).join(' — ');
  useEffect(() => {
    if (title === null) {
      if (page.current !== null) document.title = page.current;
      page.current = null;
      return;
    }
    page.current ??= document.title;
    document.title = title;
  }, [title]);
  return null;
}
