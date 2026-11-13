// Prototype adapter: extend Moss's existing note menu without editing the vendored shell.
// A production follow-up should replace DOM discovery with a typed note-menu host slot.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Cloud, FolderRoot, History, PencilLine, UserPlus } from 'lucide-react';
import { useDocRole } from '../access.ts';
import { useAuthState } from '../auth.ts';
import { useDocConnection } from '../collab/connection.ts';
import { useTerminal } from '../collab/terminal.ts';
import { openSuggestion } from '../collab/suggest/SuggestionsPanel.tsx';
import { setHistoryOpen } from '../history/HistoryView.tsx';
import { openNotifications } from './NotificationsBell.tsx';
import { openShare } from './ShareDialog.tsx';

export function NoteMenuExtras({ docId }: { docId: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const role = useDocRole(docId);
  const auth = useAuthState();
  const connection = useDocConnection(docId);
  const terminal = useTerminal(docId);
  useEffect(() => {
    const sync = () => {
      const group = anchor.current?.closest('[data-editor-pane]') ?? anchor.current?.parentElement;
      const trigger = group?.querySelector('[aria-label="More actions"]');
      const id = trigger?.getAttribute('aria-controls');
      setMenu(id && trigger?.getAttribute('aria-expanded') === 'true' ? document.getElementById(id) : null);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-controls'] });
    sync();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!menu) return;
    // Base UI cannot register items across the host seam. Include both groups in one roving list.
    const keys = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item => item.getClientRects().length && item.getAttribute('aria-disabled') !== 'true');
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      event.preventDefault(); event.stopImmediatePropagation(); items[next]?.focus();
    };
    menu.addEventListener('keydown', keys, true);
    return () => menu.removeEventListener('keydown', keys, true);
  }, [menu]);
  const act = (work: () => void) => {
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    requestAnimationFrame(work);
  };
  const row = 'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-ink-default outline-none hover:bg-surface-panel focus:bg-surface-panel';
  const icon = 'h-3.5 w-3.5 text-ink-faint';
  return <><span ref={anchor} className="hidden" />{menu ? createPortal(<div data-note-menu-extras="">
    <div role="separator" className="-mx-1 my-1 h-px bg-border-subtle" />
    {role === 'owner' && !terminal ? <button role="menuitem" tabIndex={-1} className={row} onClick={() => act(() => openShare({ type: 'doc', id: docId }))}><UserPlus className={icon} strokeWidth={1.5} />Share note…</button> : null}
    <button role="menuitem" tabIndex={-1} className={row} onClick={() => act(() => openSuggestion(docId, null))}><PencilLine className={icon} strokeWidth={1.5} />Suggestions…</button>
    {auth.status === 'signed-in' ? <>
      <button role="menuitem" tabIndex={-1} className={row} onClick={() => act(() => setHistoryOpen(docId, true))}><History className={icon} strokeWidth={1.5} />Version history…</button>
      <button role="menuitem" tabIndex={-1} className={row} onClick={() => act(openNotifications)}><Bell className={icon} strokeWidth={1.5} />Notifications…</button>
      <button role="menuitem" tabIndex={-1} className={row} onClick={() => act(() => {
        const settings = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Settings');
        settings?.click();
      })}><FolderRoot className={icon} strokeWidth={1.5} />Vaults in Settings…</button>
    </> : null}
    <div className="flex items-center gap-2 px-2 py-1.5 text-micro text-ink-faint" role="status"><Cloud className={icon} strokeWidth={1.5} />{terminal ? 'Disconnected' : connection?.connection === 'online' ? 'Connected' : connection?.connection === 'offline' ? 'Offline' : 'Connecting…'}</div>
  </div>, menu) : null}</>;
}
