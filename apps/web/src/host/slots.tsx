// Host slots the vendored notes list and Settings call through moss-multi seams (A§2.2: seam once, fill in host).
// Each renders nothing until the task named beside it fills it.
import type { ReactNode } from 'react';
import { AccountSection } from './surfaces/AccountSection.tsx';
import { AgentsSection } from './surfaces/AgentsSection.tsx';
import { FolderShareItem } from './surfaces/ShareEntryPoints.tsx';
import { VaultSwitcher } from './surfaces/VaultSwitcher.tsx';
export { CollaborationDoor as TopBarCollab } from './surfaces/CollaborationDoor.tsx';
import { getBridge, WORKSPACE } from './bridge/index.ts';

/** True for a doc surfaced at the vault root because it was shared directly (A§11); it offers no move. T1.2. */
export const surfacedShared = (docId: string): boolean => getBridge()?.[WORKSPACE].surfacedShared(docId) ?? false;
export const surfacedFolder = (path: string): boolean => getBridge()?.[WORKSPACE].surfacedFolder(path) ?? false;

/** Items added to a folder's context menu: "Share…" for its owner (T2.4). */
export const FolderMenuItems: (props: { folderPath: string }) => ReactNode = ({ folderPath }) => <FolderShareItem folderPath={folderPath} />;

/** Sections added to moss's Settings dialog: Account with Sign out (T0.10), then Agents (T3.6). */
export const SettingsSections: () => ReactNode = () => <><section className="space-y-2"><span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Vaults</span><VaultSwitcher inCollaboration /></section><AccountSection /><AgentsSection /></>;
