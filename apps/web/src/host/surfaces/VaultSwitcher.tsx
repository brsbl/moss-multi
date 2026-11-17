// Glyphdown's owned-first vault menu, composed from moss's DS in the notes-panel header (A§11). On a vault the caller
// owns, the menu ends with "Share vault…" (T2.4) and an inline "New vault" row, and an always-visible actions button
// beside it offers Rename and Move to Trash (T3.5); members get no vault actions.
import { useRef, useState, useSyncExternalStore, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { getDefaultStore } from 'jotai';
import { activeFolderPathAtom } from '@moss/shared/state/atoms';
import { Check, ChevronDown, FolderRoot, MoreHorizontal, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { Button } from '@moss/shared/components/ui/button';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { Input } from '@moss/shared/components/ui/input';
import { getBridge, WORKSPACE, type Bridge } from '../bridge/index.ts';
import { openShare } from './ShareDialog.tsx';

// moss's DropdownMenu is Base UI's Menu root, which takes a controlled `open`; the Content takes `onCloseAutoFocus`.
const Menu = DropdownMenu as ComponentType<{ children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }>;
const MenuContent = DropdownMenuContent as ComponentType<ComponentProps<typeof DropdownMenuContent> & { onCloseAutoFocus?: (event: Event) => void }>;

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
const holdHover = { onMouseMoveCapture: stop, onPointerMoveCapture: stop, onMouseOverCapture: stop, onPointerOverCapture: stop };

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

export function VaultSwitcher() {
  const bridge = getBridge();
  return bridge ? <VaultMenu bridge={bridge} /> : null;
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

  return (
    <div className="relative mr-auto flex min-w-0 flex-1 items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <NameInput label="Vault name" initial={active.name} commitOnBlur onCommit={(name) => { void rename(name); }} onCancel={() => setRenaming(false)} />
        ) : (
          <Menu open={open} onOpenChange={(next) => { setOpen(next); if (!next) setCreating(false); }}>
            <DropdownMenuTrigger asChild>
              <Button data-collab-chrome="" variant="ghost" size="sm" disabled={pending} aria-label={`Vault: ${active.name}`} className="max-w-full gap-1.5 px-1.5">
                <FolderRoot className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                <span className="truncate">{active.name}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            {/* While the inline row is open, hovering an item must not move focus out of its field. */}
            <MenuContent align="start" className="w-60 max-w-[calc(100vw-2rem)]" {...(creating ? holdHover : {})}>
              {vaults.map((vault) => (
                <DropdownMenuItem key={vault.id} onSelect={() => { void switchTo(vault.id); }}>
                  <FolderRoot className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{vault.name}</span>
                  {!vault.owned && vault.role && <span className="rounded bg-surface-note-hover px-1.5 py-0.5 text-nano text-ink-muted">{vault.role}</span>}
                  {vault.id === active.id && <Check className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />}
                </DropdownMenuItem>
              ))}
              {(owned || active.role === 'owner') && <div role="separator" className="-mx-1 my-1 h-px bg-border-subtle" />}
              {/* A granted co-owner may share the vault (T2.4); create, rename and trash stay with its owner (T3.5). */}
              {active.role === 'owner' && (
                <DropdownMenuItem onSelect={() => openShare({ type: 'folder', id: active.id, name: active.name, vault: true })}>
                  <UserPlus className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">Share vault…</span>
                </DropdownMenuItem>
              )}
              {owned && (
                <>
                  {creating ? (
                    <NewVaultRow onCreate={create} onCancel={() => setCreating(false)} />
                  ) : (
                    // Kept open: the row replaces the item inside the menu (glyphdown's inline create).
                    <DropdownMenuItem onClick={(event) => { event.preventDefault(); setCreating(true); }}>
                      <Plus className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">New vault</span>
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </MenuContent>
          </Menu>
        )}
      </div>
      {owned && !renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button data-collab-chrome="" type="button" aria-label="Vault actions" disabled={pending}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none">
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          {/* The rename input takes focus, so the menu does not hand it back to its trigger. */}
          <MenuContent align="start" className="w-48" onCloseAutoFocus={(event) => { if (renaming) event.preventDefault(); }}>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Rename…</span>
            </DropdownMenuItem>
            {ownedCount > 1 && (
              <DropdownMenuItem onSelect={() => setTrashing(true)} className="text-accent-terracotta">
                <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Move to Trash…</span>
              </DropdownMenuItem>
            )}
          </MenuContent>
        </DropdownMenu>
      )}
      <ConfirmationDialog open={trashing} onOpenChange={setTrashing} variant="danger" cancelAutoFocus
        title={`Move “${active.name}” to Trash?`}
        description="Every note and folder in this vault moves to Trash with it, and everyone it’s shared with loses access."
        confirmLabel="Move to Trash" cancelLabel="Cancel" onConfirm={() => { void trash(); }} />
      {error && <p role="alert" className="absolute left-1 top-full z-10 mt-0.5 text-caption text-accent-terracotta">{error}</p>}
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
