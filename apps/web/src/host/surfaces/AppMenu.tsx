// The sidebar footer's Settings opens this short app menu (T9.30): the vault on screen as a heading, then Switch
// vault…, Notifications, Connection status, Account and Settings. It is the one place these live, on every screen,
// with or without a note open; a link visitor gets only Connection status and Settings. Inbox and connection details
// open at the same footer target, which gets focus back when they close.
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@moss/shared/components/ui/dropdown-menu';
import { focusedNoteIdAtom } from '@moss/shared/state/atoms';
import { useAtomValue } from 'jotai';
import { Bell, Check, CircleUser, Cloud, FolderRoot, Plus, Settings } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactElement, type ReactNode, type RefObject } from 'react';
import { useAuthState } from '../auth.ts';
import { getBridge, WORKSPACE, type Bridge } from '../bridge/index.ts';
import { useConnectionState } from '../collab/ConnectionNotice.tsx';
import { refuseInput } from '../refusal.ts';
import { revealAccountSection } from './AccountSection.tsx';
import { APP_MENU_ATTR } from './footer.ts';
import { InboxMenu } from './NotificationsBell.tsx';
import { registerSettingsOpener, requestNewVault, sharedRoleLabel, SWITCH_FAILED, switchToVault } from './VaultSwitcher.tsx';

const Menu = DropdownMenu as ComponentType<{ children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }>;

const ROW = 'gap-2 text-xs';
const ICON = 'h-3.5 w-3.5';
const HEADING = 'px-2 py-1.5 text-xs font-normal text-ink-faint';

/** Runs once the menu has closed and handed focus back to its trigger. */
const afterClose = (run: () => void) => () => {
  setTimeout(run, 0);
};

const noSubscribe = () => () => {};
const noSnapshot = () => null;

function useWorkspace(bridge: Bridge | null) {
  return useSyncExternalStore(bridge?.[WORKSPACE].subscribe ?? noSubscribe, bridge?.[WORKSPACE].getSnapshot ?? noSnapshot, noSnapshot);
}

/** Switch vault…: the vaults as a checked list, each by name and a shared one with its role, then New vault… for
 * someone who owns one; managing them is Settings' Vaults (T9.31). */
function SwitchVault({ bridge }: { bridge: Bridge }): ReactNode {
  const workspace = useWorkspace(bridge);
  if (!workspace) return null;
  const active = workspace.vault;
  const vaults = workspace.vaults ?? [active];
  const owns = vaults.some((vault) => vault.owned ?? vault.role === 'owner');
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={ROW}>
        <FolderRoot aria-hidden className={ICON} />
        Switch vault…
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent side="right" align="start" sideOffset={4} alignOffset={-4} collisionPadding={16} className="min-w-0 w-max max-w-[min(18rem,calc(100vw-2rem))] max-h-[var(--available-height)] overflow-y-auto">
        <DropdownMenuRadioGroup
          value={active.id}
          onValueChange={(id) => {
            if (id === active.id) return;
            void switchToVault(bridge, id).then((ok) => { if (!ok) refuseInput(SWITCH_FAILED); });
          }}
        >
          {vaults.map((vault) => {
            const role = sharedRoleLabel(vault);
            return (
              <DropdownMenuRadioItem key={vault.id} value={vault.id} closeOnClick className={ROW} aria-label={role ? `${vault.name} ${role}` : vault.name}>
                <span className="flex w-3.5 shrink-0 justify-center">{vault.id === active.id ? <Check aria-hidden className={ICON} /> : null}</span>
                <span className="min-w-0 flex-1 truncate" title={vault.name}>{vault.name}</span>
                {role ? <span className="shrink-0 text-ink-faint">{' '}{role}</span> : null}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {owns ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={ROW} onSelect={afterClose(requestNewVault)}>
              <Plus aria-hidden className={ICON} />
              New vault…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Connection status, at the footer target: the focused note's connection, in words. */
function ConnectionMenu({ open, onOpenChange, anchor }: {
  open: boolean; onOpenChange: (open: boolean) => void; anchor: RefObject<HTMLElement | null>;
}): ReactNode {
  const docId = useAtomValue(focusedNoteIdAtom);
  const { label } = useConnectionState(docId);
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuContent
        align="start"
        side="top"
        anchor={anchor}
        collisionPadding={16}
        className="min-w-0 w-max max-w-[calc(100vw-2rem)]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          anchor.current?.focus();
        }}
      >
        <DropdownMenuLabel className={HEADING}>Connection status</DropdownMenuLabel>
        <div role="status" className="flex items-center gap-2 px-2 py-1.5 text-xs text-ink-default">
          <Cloud aria-hidden className={`${ICON} text-ink-faint`} />
          {docId ? label : 'No note open'}
        </div>
      </DropdownMenuContent>
    </Menu>
  );
}

/** Wraps the footer's Settings button (`children`) as the menu's trigger. */
export function AppMenu({ children, onOpenSettings }: { children: ReactElement; onOpenSettings: () => void }): ReactNode {
  const trigger = useRef<HTMLElement | null>(null);
  const auth = useAuthState();
  const bridge = getBridge() ?? null;
  const workspace = useWorkspace(bridge);
  const [detail, setDetail] = useState<'inbox' | 'connection' | null>(null);
  const signedIn = auth.status === 'signed-in';
  const vault = signedIn ? workspace?.vault ?? null : null;
  const close = (open: boolean) => { if (!open) setDetail(null); };
  useEffect(() => registerSettingsOpener(onOpenSettings), [onOpenSettings]);
  return (
    <>
      <Menu>
        <DropdownMenuTrigger asChild ref={trigger} {...{ [APP_MENU_ATTR]: '' }}>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" sideOffset={6} collisionPadding={16} className="min-w-0 w-max max-w-[calc(100vw-2rem)]">
          {vault ? <DropdownMenuLabel className={`${HEADING} max-w-64 truncate`}>Current vault: {vault.name}</DropdownMenuLabel> : null}
          {vault && bridge ? <SwitchVault bridge={bridge} /> : null}
          {signedIn ? (
            <DropdownMenuItem className={ROW} onSelect={afterClose(() => setDetail('inbox'))}>
              <Bell aria-hidden className={ICON} />
              Notifications
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className={ROW} onSelect={afterClose(() => setDetail('connection'))}>
            <Cloud aria-hidden className={ICON} />
            Connection status
          </DropdownMenuItem>
          {signedIn ? (
            <DropdownMenuItem className={ROW} onSelect={() => { revealAccountSection(); onOpenSettings(); }}>
              <CircleUser aria-hidden className={ICON} />
              Account
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className={ROW} onSelect={onOpenSettings}>
            <Settings aria-hidden className={ICON} />
            Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </Menu>
      {signedIn ? <InboxMenu open={detail === 'inbox'} onOpenChange={close} anchor={trigger} /> : null}
      <ConnectionMenu open={detail === 'connection'} onOpenChange={close} anchor={trigger} />
    </>
  );
}
