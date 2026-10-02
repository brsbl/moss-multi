// ported-from: packages/desktop/src/renderer/components/SettingsModal.tsx @ 762abb777
import { useCallback, useEffect, useState } from 'react';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { Check, FolderCog, FolderOpen, Monitor, Moon, Plus, Sun, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { cn } from '@moss/shared/lib/utils';
import { noteIntelligenceEnabledAtom } from '@moss/shared/state/atoms';
import { themeChoiceAtom, type ThemeChoice } from '@moss/shared/themes';

import { appConfigApi } from '../api/electron';
import {
  isDefaultMdEditorAtom,
  refreshIsDefaultMdEditorAtom,
  setIsDefaultMdEditorAtom
} from '../state/default-editor-atoms';
import {
  grantedDirsAtom,
  grantNewDirectoryAtom,
  revokeGrantedDirectoryAtom
} from '../state/granted-dirs-atoms';
import { refreshWorkspaceInfoAtom, workspaceInfoAtom } from '../state/workspace-info-atoms';
import { ModalShell } from './ModalShell';
// moss-multi seam: settings-account (BUILDPLAN T0.10: sign-out lives in Settings)
import { AccountSection } from '@moss-multi/host/surfaces/AccountSection';

function toTildePath(fullPath: string): string {
  return fullPath.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}
interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; Icon: typeof Monitor }> = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon }
];

function AppearanceSection() {
  const [themeChoice, setThemeChoice] = useAtom(themeChoiceAtom);

  return (
    <div className="space-y-2">
      <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Appearance</span>
      <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs font-medium text-ink-default">Theme</span>
          <div
            className="inline-flex rounded-lg border border-surface-glass-border bg-surface-canvas-bg p-1 shadow-inner"
            role="radiogroup"
            aria-label="Theme"
          >
            {THEME_OPTIONS.map(({ value, label, Icon }) => {
              const selected = themeChoice === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setThemeChoice(value)}
                  className={cn(
                    'inline-flex h-6 items-center gap-1.5 rounded-md px-3 text-xs font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15',
                    selected
                      ? 'bg-surface-raised-card text-ink-default shadow-sm ring-1 ring-border-strong/40'
                      : 'text-ink-faint hover:bg-surface-raised-control/50 hover:text-ink-muted'
                  )}
                >
                  <Icon aria-hidden className="h-3.5 w-3.5" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const store = useStore();
  const [noteIntelligenceEnabled, setNoteIntelligenceEnabled] = useAtom(noteIntelligenceEnabledAtom);
  const grantedDirs = useAtomValue(grantedDirsAtom);
  const workspaceInfo = useAtomValue(workspaceInfoAtom);
  const [pendingRestart, setPendingRestart] = useState(false);
  const isDefaultEditor = useAtomValue(isDefaultMdEditorAtom);
  const [settingDefault, setSettingDefault] = useState(false);

  // All visible data flows through atoms hydrated at app startup + preloaded
  // on the Settings button click, so there's no per-open IPC fetch and no
  // mount flash. The only per-open reset is `pendingRestart` (a UI message
  // that should not persist across opens).
  useEffect(() => {
    if (!open) return;
    setPendingRestart(false);
  }, [open]);

  const handleGrantDir = useCallback(async () => {
    try {
      await store.set(grantNewDirectoryAtom, { surface: 'settings_modal' });
    } catch {
      // Silently fail — user cancelled or error
    }
  }, [store]);

  const handleRevokeDir = useCallback(async (dirPath: string) => {
    try {
      await store.set(revokeGrantedDirectoryAtom, dirPath);
    } catch {
      // Silently fail
    }
  }, [store]);

  const handleToggleNoteIntelligence = useCallback(async () => {
    const next = !noteIntelligenceEnabled;
    try {
      await window.electronAPI?.settings?.setNoteIntelligence(next);
      setNoteIntelligenceEnabled(next);
    } catch {
      // Silently fail
    }
  }, [noteIntelligenceEnabled, setNoteIntelligenceEnabled]);

  const handleChangeWorkspace = useCallback(async () => {
    try {
      const picked = await appConfigApi.pickWorkspaceFolder.invoke();
      if (!picked) return;
      const result = await appConfigApi.setWorkspacePath.invoke(picked);
      if (result.success) {
        setPendingRestart(true);
        const prev = store.get(workspaceInfoAtom);
        store.set(workspaceInfoAtom, prev
          ? { ...prev, path: picked, effectivePath: picked }
          : { path: picked, effectivePath: picked, envOverride: false });
        void store.set(refreshWorkspaceInfoAtom);
      }
    } catch {
      // User cancelled or error
    }
  }, [store]);


  const handleSetDefaultEditor = useCallback(async () => {
    setSettingDefault(true);
    try {
      const success = await window.electronAPI?.settings?.setDefaultMdEditor();
      if (success) {
        store.set(setIsDefaultMdEditorAtom, true);
      }
    } catch {
      // OS dialog was cancelled or failed
    } finally {
      setSettingDefault(false);
      // Definitive re-check in case the user confirmed via an OS dialog.
      // refresh bumps the generation, so any slower in-flight ensure won't
      // overwrite the post-refresh value.
      void store.set(refreshIsDefaultMdEditorAtom);
    }
  }, [store]);

  const workspaceDisplayPath = workspaceInfo
    ? (workspaceInfo.envOverride ? workspaceInfo.effectivePath : (workspaceInfo.path ?? workspaceInfo.effectivePath))
    : '';

  return (
    <ModalShell open={open} onOpenChange={onOpenChange} title="Settings" description="Manage workspace, editor, and external directory settings.">

            {/* moss-multi seam: settings-account (BUILDPLAN T0.10) */}
            <AccountSection />

            <AppearanceSection />

            {/* Workspace Location */}
            {workspaceInfo && (
              <div className="space-y-2">
                <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Workspace Location</span>
                <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-ink-muted" title={workspaceDisplayPath}>
                      {toTildePath(workspaceDisplayPath)}
                    </span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <TooltipProvider delayDuration={400}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={handleChangeWorkspace}
                              disabled={workspaceInfo.envOverride}
                              className="flex h-6 w-6 items-center justify-center rounded text-ink-faint transition-colors hover:bg-border-subtle hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label="Change workspace location"
                            >
                              <FolderCog aria-hidden className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs">Change</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </div>
                  {workspaceInfo.envOverride && (
                    <div className="mt-1.5">
                      <span className="text-xs italic text-ink-faint">Set by MOSS_WORKSPACE_ROOT environment variable</span>
                    </div>
                  )}
                  {pendingRestart && (
                    <p className="mt-1.5 text-xs text-ink-faint">Restart to apply. Existing notes stay in their current location.</p>
                  )}
                </div>
              </div>
            )}

            {/* Default Markdown Editor */}
            <div className="space-y-2">
              <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Default Markdown Editor</span>
              <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
                {isDefaultEditor ? (
                  <div className="flex items-center gap-2">
                    <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent-brand" />
                    <span className="text-xs text-ink-muted">Moss is your default editor for .md files</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-muted">Set Moss as your default editor for .md files</span>
                    <button
                      type="button"
                      onClick={handleSetDefaultEditor}
                      disabled={settingDefault}
                      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-border-subtle hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {settingDefault ? 'Setting...' : 'Set as Default'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Note Intelligence */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Note Intelligence</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={noteIntelligenceEnabled}
                  onClick={handleToggleNoteIntelligence}
                  className="inline-flex h-6 w-7 shrink-0 cursor-pointer items-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-flex h-4 w-7 items-center rounded-full border p-px shadow-inner transition-colors',
                      noteIntelligenceEnabled
                        ? 'border-accent-brand/50 bg-accent-brand'
                        : 'border-surface-glass-border bg-surface-panel/70'
                    )}
                  >
                    <span
                      className={cn(
                        'block h-3 w-3 rounded-full bg-ink-inverse shadow-floating ring-1 ring-border-strong/30 transition-transform',
                        noteIntelligenceEnabled ? 'translate-x-3' : 'translate-x-0'
                      )}
                    />
                  </span>
                </button>
              </div>
              <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
                <ul className="space-y-2">
                  <li className="flex items-start gap-2">
                    <div>
                      <a href="https://mossnotes.app/features#auto-properties" target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-ink-default hover:underline">Default Properties</a>
                      <p className="text-xs text-ink-muted">Adds and updates description, tags, and status as you write</p>
                    </div>
                  </li>
                  <li className="flex items-start gap-2">
                    <div>
                      <a href="https://mossnotes.app/features#suggested-links" target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-ink-default hover:underline">Related Notes</a>
                      <p className="text-xs text-ink-muted">Surfaces related notes based on shared topics and tags</p>
                    </div>
                  </li>
                </ul>
              </div>
            </div>

            {/* Connected Folders Section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Connected Folders</span>
                <button
                  type="button"
                  onClick={handleGrantDir}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-border-subtle hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                >
                  <Plus aria-hidden className="h-3.5 w-3.5" />
                  <span>Add</span>
                </button>
              </div>
              <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
                {grantedDirs.length === 0 ? (
                  <p className="text-xs text-ink-faint">
                    You can @mention Connected Folders in Actions to give Moss additional
                    context. Access is read-only, only at the time you @mention.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {grantedDirs.map((dir) => (
                      <li key={dir} className="group/dir flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <FolderOpen aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                          <span className="truncate text-xs text-ink-muted" title={dir}>{dir}</span>
                        </div>
                        <TooltipProvider delayDuration={400}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => handleRevokeDir(dir)}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition-all group-hover/dir:opacity-100 hover:text-accent-terracotta focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                                aria-label={`Revoke access to ${dir}`}
                              >
                                <X aria-hidden className="h-3.5 w-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="text-xs">Revoke</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </li>
                    ))}
                  </ul>
                )}
                {grantedDirs.length > 0 && (
                  <p className="mt-2 text-xs text-ink-faint">
                    You can @mention Connected Folders in Actions to give Moss additional
                    context. Access is read-only, only at the time you @mention.
                  </p>
                )}
              </div>
            </div>

    </ModalShell>
  );
}
