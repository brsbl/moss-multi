// Vault navigation and management are disclosed inside Settings; the note-list header remains Moss’s.
import { useRef, useState, useSyncExternalStore } from 'react';
import { getDefaultStore } from 'jotai';
import { activeFolderPathAtom } from '@moss/shared/state/atoms';
import { Check, ChevronDown, FolderRoot, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { Input } from '@moss/shared/components/ui/input';
import { TRASH_COPY } from '@moss-multi/protocol/retention';
import { getBridge, WORKSPACE, type Bridge } from '../bridge/index.ts';
import { openShare } from './ShareDialog.tsx';

const UNREACHABLE = 'The server couldn’t be reached. Check your connection and try again.';

/** A vault request; a refusal throws the server's sentence. */
async function vaultRequest(path: string, method: string, body?: unknown): Promise<{ vault?: { id: string } }> {
  let response: Response;
  try {
    response = await fetch(path, {
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

export function VaultSwitcher() { return null; }

/** Workspace management lives in Settings; the desktop sidebar header stays empty. */
export function VaultSettingsSection() {
  const bridge = getBridge();
  return bridge ? <section className="space-y-2"><h3 className="text-micro font-medium uppercase tracking-wider text-ink-faint">Vaults</h3><VaultMenu bridge={bridge} /></section> : null;
}

function VaultMenu({ bridge }: { bridge: Bridge }) {
  const workspace = useSyncExternalStore(bridge[WORKSPACE].subscribe, bridge[WORKSPACE].getSnapshot);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!workspace) return null;
  const active = workspace.vault;
  const vaults = workspace.vaults ?? [active];
  const owned = active.owned ?? active.role === 'owner';
  const ownedCount = vaults.filter((vault) => vault.owned).length;

  const switchTo = async (id: string) => {
    setPending(true);
    setError(null);
    try {
      await bridge[WORKSPACE].switchVault(id);
      getDefaultStore().set(activeFolderPathAtom, 'Notes');
    } catch {
      setError('Could not switch vaults. Please try again.');
    } finally {
      setPending(false);
    }
  };
  const create = async (name: string) => {
    const { vault } = await vaultRequest('/api/vaults', 'POST', { name });
    setCreating(false);
    setOpen(false);
    if (vault) await switchTo(vault.id);
  };
  const rename = async (name: string) => {
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
    await switchTo(active.id);
  };

  const item = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-ink-default hover:bg-surface-panel focus-visible:bg-surface-panel focus-visible:outline-none';
  return (
    <div className="relative space-y-2">
      <button type="button" aria-label={`Vault: ${active.name}`} aria-expanded={open} disabled={pending}
        onClick={() => setOpen(!open)} className="flex h-7 items-center gap-2 rounded px-2 text-xs text-ink-muted hover:bg-surface-note-hover/40 focus-visible:ring-1 focus-visible:ring-ink-default/15">
        <FolderRoot className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        {active.name}<ChevronDown className="h-3 w-3" strokeWidth={1.5} aria-hidden />
      </button>
      {open && <div role="group" aria-label="Vaults" className="rounded-md border border-border-subtle bg-surface-floating p-1 text-ink-default shadow-md">
        {vaults.map(vault => <button key={vault.id} type="button" className={item} disabled={pending} onClick={() => { void switchTo(vault.id); setOpen(false); }}>
          <FolderRoot className="h-3.5 w-3.5 text-ink-faint" strokeWidth={1.5} aria-hidden /><span className="flex-1 truncate">{vault.name}</span>
          {vault.id === active.id && <Check className="h-3.5 w-3.5 text-ink-muted" strokeWidth={1.5} aria-label="Current vault" />}
          {!vault.owned && <span className="text-micro text-ink-faint">{vault.role}</span>}
        </button>)}
        <div role="separator" className="-mx-1 my-1 h-px bg-border-subtle" />
        {active.role === 'owner' && <button type="button" className={item} onClick={() => openShare({ type: 'folder', id: active.id, name: active.name, vault: true })}><UserPlus className="h-3.5 w-3.5 text-ink-faint" strokeWidth={1.5} />Share vault…</button>}
        {owned && <>
          {creating ? <NewVaultRow onCreate={create} onCancel={() => setCreating(false)} /> : <button type="button" className={item} onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5 text-ink-faint" strokeWidth={1.5} />New vault…</button>}
          {renaming ? <NameInput label="Vault name" initial={active.name} commitOnBlur onCommit={name => { void rename(name); }} onCancel={() => setRenaming(false)} /> : <button type="button" className={item} onClick={() => setRenaming(true)}><Pencil className="h-3.5 w-3.5 text-ink-faint" strokeWidth={1.5} />Rename vault…</button>}
          {ownedCount > 1 && <button type="button" className={item} onClick={() => setTrashing(true)}><Trash2 className="h-3.5 w-3.5 text-ink-faint" strokeWidth={1.5} />Move vault to Trash…</button>}
        </>}
      </div>}
      <ConfirmationDialog open={trashing} onOpenChange={setTrashing} variant="danger" cancelAutoFocus title={`Move “${active.name}” to Trash?`} description={TRASH_COPY.trashVault(active.name)} confirmLabel="Move to Trash" cancelLabel="Cancel" onConfirm={() => { void trash(); }} />
      {error && <p role="alert" className="text-caption text-accent-terracotta">{error}</p>}
    </div>
  );
}

/**
 * A name field: Enter commits a non-empty name, Escape cancels, and keys stay out of the surrounding menu. It goes
 * read-only, never disabled, while a request is out, so focus stays in it for a retry (METHOD: login fields).
 */
function NameInput({ label, initial = '', placeholder, busy = false, commitOnBlur = false, onCommit, onCancel }: {
  label: string; initial?: string; placeholder?: string; busy?: boolean; commitOnBlur?: boolean;
  onCommit: (name: string) => void; onCancel: () => void;
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
    <Input autoFocus aria-label={label} value={name} placeholder={placeholder} readOnly={busy}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => {
        if (busy) return;
        if (commitOnBlur) commit();
        else if (!name.trim()) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { done.current = true; onCancel(); return; }
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
      className="h-7 px-1.5 text-sm" />
  );
}

/** The inline "New vault" row: a refusal shows its sentence under the field and keeps the name. */
function NewVaultRow({ onCreate, onCancel }: { onCreate: (name: string) => Promise<void>; onCancel: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="px-1 py-1">
      <div className="flex items-center gap-1.5 pl-1">
        <FolderRoot className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
        <NameInput label="New vault name" placeholder="Vault name" busy={pending} onCancel={onCancel}
          onCommit={(name) => {
            setPending(true);
            setError(null);
            onCreate(name).catch((failure: Error) => {
              setError(failure.message);
              setPending(false);
            });
          }} />
      </div>
      {error && <p role="alert" className="mt-1 px-1 text-caption text-accent-terracotta">{error}</p>}
    </div>
  );
}
