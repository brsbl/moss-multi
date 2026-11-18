// Vaults (A§11; T9.31): the notes-panel header is Moss's, empty but for its toggle. Switching lives in the footer's app
// menu (AppMenu: Switch vault…, New vault…); managing lives here, as a Settings section in Moss's own vocabulary (a micro
// label with a header action over a bordered card, as Connected Folders), closed at rest. Opened, it lists the vaults
// and offers, on the vault on screen, Rename… and Move to Trash… to its owner (T3.5) and Share vault… to an owner or a
// granted co-owner (T2.4), and New vault to anyone who owns a vault. Share vault… closes Settings first and comes back
// to it, focus on Share vault…, when the share dialog closes.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { getDefaultStore } from 'jotai';
import { activeFolderPathAtom } from '@moss/shared/state/atoms';
import { ChevronDown, FolderRoot, Plus } from 'lucide-react';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { Input } from '@moss/shared/components/ui/input';
import { TRASH_COPY } from '@moss-multi/protocol/retention';
import type { Role } from '@moss-multi/protocol/roles';
import { useAuthState } from '../auth.ts';
import { sessionFetch } from '../session-fetch.ts';
import { getBridge, WORKSPACE, type Bridge, type Vault } from '../bridge/index.ts';
import { ACCESS_LABEL, openShare } from './ShareDialog.tsx';

export const SWITCH_FAILED = 'Could not switch vaults. Please try again.';
const UNREACHABLE = 'The server couldn’t be reached. Check your connection and try again.';

/** The words for a vault shared with the caller (its role), or null for one they own. */
export function sharedRoleLabel(vault: Vault): string | null {
  if (vault.owned ?? vault.role === 'owner') return null;
  return vault.role && vault.role in ACCESS_LABEL ? ACCESS_LABEL[vault.role as Role] : null;
}

/** A vault request; a refusal throws the server's sentence. */
async function vaultRequest(path: string, method: string, body?: unknown): Promise<{ vault?: { id: string } }> {
  let response: Response;
  try {
    response = await sessionFetch(path, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  const answer = await response.json().catch(() => ({})) as { message?: unknown; vault?: { id: string } };
  if (!response.ok) throw new Error(typeof answer.message === 'string' && answer.message ? answer.message : 'That didn’t work. Please try again.');
  return answer;
}

/** Switches to vault `id` and back to its top level; false when the switch failed. */
export async function switchToVault(bridge: Bridge, id: string): Promise<boolean> {
  try {
    await bridge[WORKSPACE].switchVault(id);
    getDefaultStore().set(activeFolderPathAtom, 'Notes');
    return true;
  } catch {
    return false;
  }
}

// The footer's app menu hands over how Settings opens, so New vault… and a closed share dialog can open it.
let openSettings: (() => void) | null = null;
export function registerSettingsOpener(open: () => void): () => void {
  openSettings = open;
  return () => {
    if (openSettings === open) openSettings = null;
  };
}

type Reveal = 'create' | 'share';
let reveal: Reveal | null = null;

/** Opens Settings on Vaults, disclosed, its New vault field taking focus (the app menu's New vault…). */
export function requestNewVault(): void {
  reveal = 'create';
  openSettings?.();
}

/** Focuses `ref` once the dialog's own first focus has run. */
function focusSoon(ref: RefObject<HTMLElement | null>): void {
  let tries = 0;
  const step = () => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.focus();
    if (++tries < 6) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const noSubscribe = () => () => {};
const noSnapshot = () => null;

const SECTION_LABEL = 'text-micro font-medium uppercase tracking-wider text-ink-faint';
// Moss's Settings text actions (Connected Folders' Add, Account's Sign out).
const ACTION = 'flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-border-subtle hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-60';

/** Settings' Vaults section, for a signed-in person; a link visitor never sees vault names here. */
export function VaultsSection({ onClose }: { onClose: () => void }): ReactNode {
  const auth = useAuthState();
  const bridge = getBridge() ?? null;
  const workspace = useSyncExternalStore(bridge?.[WORKSPACE].subscribe ?? noSubscribe, bridge?.[WORKSPACE].getSnapshot ?? noSnapshot, noSnapshot);
  if (auth.status !== 'signed-in' || !bridge || !workspace) return null;
  return <Vaults bridge={bridge} active={workspace.vault} vaults={workspace.vaults ?? [workspace.vault]} onClose={onClose} />;
}

function Vaults({ bridge, active, vaults, onClose }: { bridge: Bridge; active: Vault; vaults: Vault[]; onClose: () => void }): ReactNode {
  const asked = useRef(reveal);
  const [open, setOpen] = useState(asked.current !== null);
  const [creating, setCreating] = useState(asked.current === 'create');
  const [renaming, setRenaming] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const section = useRef<HTMLDivElement | null>(null);
  const renameButton = useRef<HTMLButtonElement | null>(null);
  const shareButton = useRef<HTMLButtonElement | null>(null);
  const createButton = useRef<HTMLButtonElement | null>(null);
  const createField = useRef<HTMLInputElement | null>(null);
  const refocus = useRef<RefObject<HTMLElement | null> | null>(null);

  useEffect(() => {
    const was = asked.current;
    reveal = null;
    if (!was) return;
    section.current?.scrollIntoView({ block: 'nearest' });
    focusSoon(was === 'create' ? createField : shareButton);
  }, []);
  // A field that closes hands focus back to the action that opened it.
  useEffect(() => {
    if (renaming || creating || !refocus.current) return;
    const target = refocus.current;
    refocus.current = null;
    target.current?.focus();
  }, [renaming, creating]);

  const owned = active.owned ?? active.role === 'owner';
  const ownsAny = vaults.some((vault) => vault.owned ?? vault.role === 'owner');
  const ownedCount = vaults.filter((vault) => vault.owned).length;

  const create = async (name: string) => {
    const { vault } = await vaultRequest('/api/vaults', 'POST', { name });
    setCreating(false);
    if (!vault) return;
    onClose();
    if (!(await switchToVault(bridge, vault.id))) setError(SWITCH_FAILED);
  };
  const rename = async (name: string) => {
    refocus.current = renameButton;
    setRenaming(false);
    if (name === active.name) return;
    setPending(true);
    setError(null);
    try {
      await vaultRequest(`/api/vaults/${encodeURIComponent(active.id)}`, 'PATCH', { name });
      await bridge[WORKSPACE].switchVault(active.id);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  };
  const trash = async () => {
    setPending(true);
    setError(null);
    try {
      await vaultRequest(`/api/vaults/${encodeURIComponent(active.id)}`, 'DELETE');
    } catch (failure) {
      setError((failure as Error).message);
      setPending(false);
      return;
    }
    setPending(false);
    // The trashed vault is no longer listed, so the listing falls back to the default vault.
    if (!(await switchToVault(bridge, active.id))) setError(SWITCH_FAILED);
  };
  const share = () => {
    onClose();
    openShare({ type: 'folder', id: active.id, name: active.name, vault: true }, {
      closed: () => {
        reveal = 'share';
        openSettings?.();
      },
    });
  };

  return (
    <div ref={section} data-collab-chrome="" className="space-y-2">
      <div className="flex items-center justify-between">
        <span className={SECTION_LABEL}>Vaults</span>
        <button type="button" className={ACTION} aria-label="Manage vaults" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span>Manage</span>
          <ChevronDown aria-hidden className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
        {open ? (
          <>
            <ul aria-label="Vaults" className="space-y-1.5">
              {vaults.map((vault) => {
                const current = vault.id === active.id;
                const role = sharedRoleLabel(vault);
                return (
                  <li key={vault.id} className="flex min-w-0 items-center gap-2">
                    <FolderRoot aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    {current && renaming ? (
                      <NameInput label="Vault name" initial={active.name} commitOnBlur
                        onCommit={(name) => { void rename(name); }}
                        onCancel={() => { refocus.current = renameButton; setRenaming(false); }} />
                    ) : (
                      <span className={`min-w-0 flex-1 truncate text-xs ${current ? 'text-ink-default' : 'text-ink-muted'}`} title={vault.name}>{vault.name}</span>
                    )}
                    {role ? <span className="shrink-0 text-xs text-ink-faint">{role}</span> : null}
                    {current && !renaming ? <span className="shrink-0 text-xs text-ink-faint">On screen</span> : null}
                  </li>
                );
              })}
            </ul>
            {owned || active.role === 'owner' || ownsAny ? (
              <div className="-mx-1 mt-3 flex flex-wrap items-center gap-1 border-t border-border-subtle pt-2">
                {owned ? (
                  <button ref={renameButton} type="button" className={ACTION} disabled={pending || renaming} onClick={() => setRenaming(true)}>Rename…</button>
                ) : null}
                {/* A granted co-owner may share the vault (T2.4); create, rename and trash stay with its owner (T3.5). */}
                {active.role === 'owner' ? (
                  <button ref={shareButton} type="button" className={ACTION} disabled={pending} onClick={share}>Share vault…</button>
                ) : null}
                {owned && ownedCount > 1 ? (
                  <button type="button" className={`${ACTION} hover:text-accent-terracotta`} disabled={pending} onClick={() => setTrashing(true)}>Move to Trash…</button>
                ) : null}
                {ownsAny && !creating ? (
                  <button ref={createButton} type="button" className={`${ACTION} ml-auto`} disabled={pending} onClick={() => setCreating(true)}>
                    <Plus aria-hidden className="h-3.5 w-3.5" />
                    <span>New vault</span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {creating ? (
              <NewVaultRow field={createField} onCreate={create} onCancel={() => { refocus.current = createButton; setCreating(false); }} />
            ) : null}
          </>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <FolderRoot aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={active.name}>{active.name}</span>
            {vaults.length > 1 ? <span className="shrink-0 text-xs text-ink-faint">{vaults.length} vaults</span> : null}
          </div>
        )}
      </div>
      {error ? <p role="alert" className="text-xs text-ink-default">{error}</p> : null}
      <ConfirmationDialog open={trashing} onOpenChange={setTrashing} variant="danger" cancelAutoFocus
        title={`Move “${active.name}” to Trash?`}
        description={TRASH_COPY.trashVault(active.name)}
        confirmLabel="Move to Trash" cancelLabel="Cancel" onConfirm={() => { void trash(); }} />
    </div>
  );
}

/**
 * A name field: Enter commits a non-empty name, Escape cancels without closing Settings, and keys stay out of the
 * dialog. It goes read-only, never disabled, while a request is out, so focus stays in it for a retry (METHOD: login
 * fields).
 */
function NameInput({ label, initial = '', placeholder, busy = false, commitOnBlur = false, field, onCommit, onCancel }: {
  label: string; initial?: string; placeholder?: string; busy?: boolean; commitOnBlur?: boolean;
  field?: RefObject<HTMLInputElement | null>; onCommit: (name: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  // Enter unmounts a rename field, and its blur must not commit a second time.
  const done = useRef(false);
  const commit = () => {
    if (busy || done.current) return;
    if (commitOnBlur) done.current = true;
    if (name.trim()) onCommit(name.trim());
    else onCancel();
  };
  return (
    <Input ref={field} autoFocus aria-label={label} value={name} placeholder={placeholder} readOnly={busy}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => {
        if (commitOnBlur && !busy && !done.current) commit();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          done.current = true;
          onCancel();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
      className="h-7 min-w-0 flex-1 px-1.5 text-xs" />
  );
}

/** The New vault row: a refusal shows its sentence under the field and keeps the name. */
function NewVaultRow({ field, onCreate, onCancel }: { field: RefObject<HTMLInputElement | null>; onCreate: (name: string) => Promise<void>; onCancel: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <FolderRoot aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <NameInput field={field} label="New vault name" placeholder="Vault name" busy={pending} onCancel={onCancel}
          onCommit={(name) => {
            setPending(true);
            setError(null);
            onCreate(name).catch((failure: Error) => {
              setError(failure.message);
              setPending(false);
            });
          }} />
      </div>
      {error ? <p role="alert" className="mt-1 text-xs text-ink-default">{error}</p> : null}
    </div>
  );
}
