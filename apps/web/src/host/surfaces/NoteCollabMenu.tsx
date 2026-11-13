// Routine collaboration actions belong to Moss's existing More actions menu.
import { DropdownMenuItem, DropdownMenuSeparator } from '@moss/shared/components/ui/dropdown-menu';
import { Bell, Check, History, LogIn, PencilLine, UserPlus, Wifi, WifiOff } from 'lucide-react';
import { can } from '@moss-multi/protocol/roles';
import { useDocRole } from '../access.ts';
import { useAuthState } from '../auth.ts';
import { useDocConnection } from '../collab/connection.ts';
import { useTerminal } from '../collab/terminal.ts';
import { requestMode, useShownMode } from '../collab/suggest/mode.ts';
import { openSuggestion } from '../collab/suggest/SuggestionsPanel.tsx';
import { setHistoryOpen } from '../history/HistoryView.tsx';
import { leaveTo } from '../navigation.ts';
import { openShare } from './ShareDialog.tsx';
import { openNotifications } from './NotificationsBell.tsx';

export function NoteCollabMenuItems({ docId }: { docId: string }) {
  const role = useDocRole(docId);
  const auth = useAuthState();
  const mode = useShownMode(docId);
  const connection = useDocConnection(docId);
  const terminal = useTerminal(docId);
  const online = !terminal && connection?.connection === 'online';
  const row = 'gap-2 text-xs';
  const icon = 'h-3.5 w-3.5';
  // Let the menu finish restoring focus before opening another surface.
  const after = (action: () => void) => () => requestAnimationFrame(action);
  return <>
    {role === 'owner' && !terminal && <DropdownMenuItem className={row} onSelect={after(() => openShare({ type: 'doc', id: docId }))}><UserPlus className={icon} />Share…</DropdownMenuItem>}
    {can(role, 'edit') && !terminal && <DropdownMenuItem className={row} onSelect={after(() => requestMode(docId, mode === 'suggest' ? 'edit' : 'suggest'))}>{mode === 'suggest' ? <Check className={icon} /> : <PencilLine className={icon} />}{mode === 'suggest' ? 'Stop suggesting' : 'Suggest changes'}</DropdownMenuItem>}
    {role && <DropdownMenuItem className={row} onSelect={after(() => openSuggestion(docId, null))}><PencilLine className={icon} />Suggestions…</DropdownMenuItem>}
    {auth.status === 'signed-in' && <>
      {role && !terminal && <DropdownMenuItem className={row} onSelect={after(() => setHistoryOpen(docId, true))}><History className={icon} />Version history</DropdownMenuItem>}
      <DropdownMenuItem className={row} onSelect={after(() => openNotifications(docId))}><Bell className={icon} />Notifications</DropdownMenuItem>
    </>}
    {auth.status === 'signed-out' && <DropdownMenuItem className={row} onSelect={() => leaveTo(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)}><LogIn className={icon} />Sign in</DropdownMenuItem>}
    <DropdownMenuItem className={row} disabled>{online ? <Wifi className={icon} /> : <WifiOff className={icon} />}{terminal ? 'Disconnected' : online ? 'Connected' : connection?.connection === 'offline' ? 'Offline' : 'Reconnecting…'}</DropdownMenuItem>
    <DropdownMenuSeparator />
  </>;
}
