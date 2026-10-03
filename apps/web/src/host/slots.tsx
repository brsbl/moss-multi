// Host slots the vendored notes list and Settings call through moss-multi seams (A§2.2: seam once, fill in host).
// Each renders nothing until the task named beside it fills it.
import type { ReactNode } from 'react';
import { AccountSection } from './surfaces/AccountSection.tsx';
import { ShareControl } from './surfaces/ShareDialog.tsx';
import { getBridge } from './bridge/index.ts';
export { VaultSwitcher } from './surfaces/VaultSwitcher.tsx';

/** True for a doc surfaced at the vault root because it was shared directly (A§11); it offers no move. T1.2. */
export const surfacedShared = (docId: string): boolean => getBridge()?.workspace.surfacedShared(docId) ?? false;
export const surfacedFolder = (path: string): boolean => getBridge()?.workspace.surfacedFolder(path) ?? false;

/** Items added to a folder's context menu: "Share..." (T2.4). */
export const FolderMenuItems: (props: { folderPath: string }) => ReactNode = () => null;

/** Sections added to moss's Settings dialog: Account with Sign out (T0.10), then Agents (T3.6). */
export const SettingsSections: () => ReactNode = () => <AccountSection />;

/** Web chrome at the start of an open note's top-bar right group: Share, the connection indicator, the face pile and
 * the bell (T1.1, T1.3, T1.5, T2.8). */
export const TopBarCollab: (props: { docId: string }) => ReactNode = ({ docId }) => <ShareControl docId={docId} />;
