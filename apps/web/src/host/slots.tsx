// Host slots the vendored notes list and Settings call through moss-multi seams (A§2.2: seam once, fill in host).
// Each renders nothing until the task named beside it fills it.
import { Eye } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { useDocRole } from './access.ts';
import { FacePile } from '../../../../packages/ui/src/FacePile.tsx';
import { usePeers } from './collab/presence.ts';
import type { ReactNode } from 'react';
import { ConnectionIndicator } from './collab/ConnectionNotice.tsx';
import { AccountSection } from './surfaces/AccountSection.tsx';
import { AgentsSection } from './surfaces/AgentsSection.tsx';
import { NotificationsBell } from './surfaces/NotificationsBell.tsx';
import { NoteMenuExtras } from './surfaces/NoteMenuExtras.tsx';
import { VaultSettingsSection } from './surfaces/VaultSwitcher.tsx';
import { FolderShareItem, SignInToDoMore } from './surfaces/ShareEntryPoints.tsx';
import { getBridge, WORKSPACE } from './bridge/index.ts';

/** True for a doc surfaced at the vault root because it was shared directly (A§11); it offers no move. T1.2. */
export const surfacedShared = (docId: string): boolean => getBridge()?.[WORKSPACE].surfacedShared(docId) ?? false;
export const surfacedFolder = (path: string): boolean => getBridge()?.[WORKSPACE].surfacedFolder(path) ?? false;

/** Items added to a folder's context menu: "Share…" for its owner (T2.4). */
export const FolderMenuItems: (props: { folderPath: string }) => ReactNode = ({ folderPath }) => <FolderShareItem folderPath={folderPath} />;

/** Sections added to moss's Settings dialog: Account with Sign out (T0.10), then Agents (T3.6). */
export const SettingsSections: () => ReactNode = () => <><VaultSettingsSection /><AccountSection /><AgentsSection /></>;

/** Conditional presence, permission and attention cues; infrequent actions extend Moss’s existing overflow. */
export const TopBarCollab: (props: { docId: string }) => ReactNode = ({ docId }) => (
  <><ReadOnlyState docId={docId} /><FacePile peers={usePeers(docId)} /><SignInToDoMore /><NoteMenuExtras docId={docId} /><ConnectionIndicator docId={docId} /><NotificationsBell /></>
);

function ReadOnlyState({ docId }: { docId: string }) {
  const role = useDocRole(docId);
  if (role !== 'viewer' && role !== 'commenter') return null;
  const label = role === 'viewer' ? 'View only' : 'Can comment';
  return <TooltipProvider><Tooltip><TooltipTrigger asChild><span tabIndex={0} aria-label={label} className="flex h-7 w-7 items-center justify-center rounded text-ink-faint"><Eye className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden /></span></TooltipTrigger><TooltipContent side="bottom">{label} · editing is unavailable</TooltipContent></Tooltip></TooltipProvider>;
}
