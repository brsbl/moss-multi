// Host slots the vendored notes list and Settings call through moss-multi seams (A§2.2: seam once, fill in host).
// Each renders nothing until the task named beside it fills it.
import type { ReactElement, ReactNode } from 'react';
import type { SuggestionsSource } from './collab/suggest/SuggestionsPanel.tsx';
import { AccountSection } from './surfaces/AccountSection.tsx';
import { AgentsSection } from './surfaces/AgentsSection.tsx';
import { AppMenu } from './surfaces/AppMenu.tsx';
import { NoteMenuItems as NoteMenuEntries } from './surfaces/NoteMenuItems.tsx';
import { FolderShareItem } from './surfaces/ShareEntryPoints.tsx';
import { TopBarCues } from './surfaces/TopBarCues.tsx';
import { VaultsSection } from './surfaces/VaultSwitcher.tsx';
import { getBridge, WORKSPACE } from './bridge/index.ts';

/** True for a doc surfaced at the vault root because it was shared directly (A§11); it offers no move. T1.2. */
export const surfacedShared = (docId: string): boolean => getBridge()?.[WORKSPACE].surfacedShared(docId) ?? false;
export const surfacedFolder = (path: string): boolean => getBridge()?.[WORKSPACE].surfacedFolder(path) ?? false;

/** Items added to a folder's context menu: "Share…" for its owner (T2.4). */
export const FolderMenuItems: (props: { folderPath: string }) => ReactNode = ({ folderPath }) => <FolderShareItem folderPath={folderPath} />;

/** Sections added to moss's Settings dialog: Vaults (T9.31), Account with Sign out (T0.10), then Agents (T3.6).
 * `onClose` closes Settings, as Share vault… does before its own dialog opens. */
export const SettingsSections: (props: { onClose: () => void }) => ReactNode = ({ onClose }) => <><VaultsSection onClose={onClose} /><AccountSection /><AgentsSection /></>;

/** Web cues at the start of an open note's top-bar right group, each only while it has something to say: People
 * here, the unread bell and the open-suggestions count (T9.30). */
export const TopBarCollab: (props: { docId: string; suggestions: SuggestionsSource | null }) => ReactNode = ({ docId, suggestions }) => (
  <TopBarCues docId={docId} suggestions={suggestions} />
);

/** Entries added to an open note's More actions before Trash: Share…, Suggestions, Suggest changes, Version
 * history (T9.30). */
export const NoteMenuItems: (props: { docId: string }) => ReactNode = ({ docId }) => <NoteMenuEntries docId={docId} />;

/** The sidebar footer's Settings button, wrapped as the trigger of the app menu (T9.30). */
export const SettingsFooterMenu: (props: { children: ReactElement; onOpenSettings: () => void }) => ReactNode = (props) => <AppMenu {...props} />;
