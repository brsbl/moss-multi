// Host slots the vendored notes list and Settings call through moss-multi seams (A§2.2: seam once, fill in host).
// Each renders nothing until the task named beside it fills it.
import { FacePile } from '../../../../packages/ui/src/FacePile.tsx';
import { usePeers } from './collab/presence.ts';
import type { ReactNode } from 'react';
import { ConnectionIndicator } from './collab/ConnectionNotice.tsx';
import { AccountSection } from './surfaces/AccountSection.tsx';
import { AgentsSection } from './surfaces/AgentsSection.tsx';
import { NotificationsBell } from './surfaces/NotificationsBell.tsx';
import { ShareControl } from './surfaces/ShareDialog.tsx';
import { FolderShareItem, SignInToDoMore } from './surfaces/ShareEntryPoints.tsx';
import { getBridge, WORKSPACE } from './bridge/index.ts';

/** True for a doc surfaced at the vault root because it was shared directly (A§11); it offers no move. T1.2. */
export const surfacedShared = (docId: string): boolean => getBridge()?.[WORKSPACE].surfacedShared(docId) ?? false;
export const surfacedFolder = (path: string): boolean => getBridge()?.[WORKSPACE].surfacedFolder(path) ?? false;

/** Items added to a folder's context menu: "Share…" for its owner (T2.4). */
export const FolderMenuItems: (props: { folderPath: string }) => ReactNode = ({ folderPath }) => <FolderShareItem folderPath={folderPath} />;

/** Sections added to moss's Settings dialog: Account with Sign out (T0.10), then Agents (T3.6). */
export const SettingsSections: () => ReactNode = () => <><AccountSection /><AgentsSection /></>;

/** Web chrome at the start of an open note's top-bar right group: the face pile, Share (or, for a link visitor, Sign
 * in to do more), the connection indicator and the bell (T1.1, T1.3, T1.5, T2.4, T2.8). */
export const TopBarCollab: (props: { docId: string }) => ReactNode = ({ docId }) => (
  <><FacePile peers={usePeers(docId)} /><SignInToDoMore /><ShareControl docId={docId} /><ConnectionIndicator docId={docId} /><NotificationsBell /></>
);
