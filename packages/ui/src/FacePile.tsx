import { Bot } from 'lucide-react';
export interface Avatar { clientId: number; name: string; color: string; isAgent: boolean }

const initials = (name: string): string => name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();

/**
 * One session's initials: a neutral 20 px mark in Moss's faint ink, never filled with the peer's colour (T9.32).
 * Decorative: the pile's button carries the names, and the roster lists each one in full.
 */
export function AvatarChip({ avatar }: { avatar: Avatar }) {
  return <span aria-hidden data-presence-client={avatar.clientId} data-presence-color={avatar.color} data-presence-name={avatar.name}
    data-presence-agent={avatar.isAgent ? '' : undefined}
    className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-surface-canvas text-[9px] font-normal text-ink-muted">
    {initials(avatar.name)}
    {avatar.isAgent ? <Bot aria-hidden className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-sm bg-surface-canvas text-ink-faint" /> : null}
  </span>;
}

/** Up to three initials overlapping by 4 px, then +N for the rest. */
export function FacePile({ peers }: { peers: Avatar[] }) {
  if (!peers.length) return null;
  return <span aria-hidden className="flex shrink-0 items-center -space-x-1">
    {peers.slice(0, 3).map(avatar => <AvatarChip key={avatar.clientId} avatar={avatar} />)}
    {peers.length > 3 ? <span className="pl-1.5 text-micro text-ink-faint">+{peers.length - 3}</span> : null}
  </span>;
}
