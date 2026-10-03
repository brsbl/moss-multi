// Host slots the vendored notes list and Settings call through moss-multi seams (A§2.2: seam once, fill in host).
// Each renders nothing until the task named beside it fills it.
import type { ReactNode } from 'react';

/** True for a doc surfaced at the vault root because it was shared directly (A§11); it offers no move. T1.2. */
export const surfacedShared: (docId: string) => boolean = () => false;

/** Items added to a folder's context menu: "Share..." (T2.4). */
export const FolderMenuItems: (props: { folderPath: string }) => ReactNode = () => null;

/** Sections added to moss's Settings dialog: Agents (T3.6). */
export const SettingsSections: () => ReactNode = () => null;

/** Web chrome at the start of an open note's top-bar right group: Share, the connection indicator, the face pile and
 * the bell (T1.1, T1.3, T1.5, T2.8). */
export const TopBarCollab: (props: { docId: string }) => ReactNode = () => null;
