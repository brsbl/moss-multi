// Glyphdown's owned-first vault menu, composed from moss's DS in the notes-panel header (A§11).
import { useState, useSyncExternalStore } from 'react';
import { getDefaultStore } from 'jotai';
import { activeFolderPathAtom } from '@moss/shared/state/atoms';
import { Check, ChevronDown, FolderRoot } from 'lucide-react';
import { Button } from '@moss/shared/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { getBridge, WORKSPACE, type Bridge } from '../bridge/index.ts';

export function VaultSwitcher() {
  const bridge = getBridge();
  return bridge ? <VaultMenu bridge={bridge} /> : null;
}

function VaultMenu({ bridge }: { bridge: Bridge }) {
  const workspace = useSyncExternalStore(bridge[WORKSPACE].subscribe, bridge[WORKSPACE].getSnapshot);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!workspace) return null;
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
  return (
    <div className="mr-auto min-w-0 flex-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={pending} aria-label={`Vault: ${workspace.vault.name}`} className="max-w-full gap-1.5 px-1.5">
            <FolderRoot className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
            <span className="truncate">{workspace.vault.name}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60 max-w-[calc(100vw-2rem)]">
          {(workspace.vaults ?? [workspace.vault]).map((vault) => (
            <DropdownMenuItem key={vault.id} onSelect={() => { void switchTo(vault.id); }}>
              <FolderRoot className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{vault.name}</span>
              {!vault.owned && vault.role && <span className="rounded bg-surface-note-hover px-1.5 py-0.5 text-nano text-ink-muted">{vault.role}</span>}
              {vault.id === workspace.vault.id && <Check className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <p role="alert" className="text-caption text-accent-terracotta">{error}</p>}
    </div>
  );
}
