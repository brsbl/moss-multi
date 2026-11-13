import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { Bot } from 'lucide-react';
export interface Avatar { clientId: number; name: string; color: string; isAgent: boolean }
/** Choose maximum-contrast ink from moss's resolved fill. */
export function avatarInk(fill: string): string {
  const rgb = fill.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!rgb || rgb.length !== 3) return 'var(--ink-primary)';
  const linear = rgb.map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  return luminance > .179 ? 'black' : 'white';
}
export function AvatarChip({ avatar }: { avatar: Avatar }) {
  return <span data-presence-client={avatar.clientId} data-presence-color={avatar.color} title={avatar.name + (avatar.isAgent ? ' (agent)' : '')} aria-label={avatar.name + (avatar.isAgent ? ' (agent)' : '')}
    className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-surface-panel text-[9px] font-normal text-ink-muted">
    {avatar.name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()}
    {avatar.isAgent ? <Bot aria-label="Agent" className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded bg-surface-canvas text-ink-muted" /> : null}
  </span>;
}
export function FacePile({ peers }: { peers: Avatar[] }) {
  if (!peers.length) return null;
  return <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" aria-label={`People here: ${peers.map(p => p.name + (p.isAgent ? ' (agent)' : '')).join(', ')}`} className="flex h-7 shrink-0 items-center -space-x-1 rounded px-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
    {peers.slice(0, 3).map(avatar => <AvatarChip key={avatar.clientId} avatar={avatar} />)}
    {peers.length > 3 ? <span className="px-1 text-xs text-ink-muted" title={peers.slice(3).map(peer => peer.name).join(', ')}>+{peers.length - 3}</span> : null}
  </button></TooltipTrigger><TooltipContent side="bottom">{peers.map(p => p.name + (p.isAgent ? ' (agent)' : '')).join(', ')}</TooltipContent></Tooltip></TooltipProvider>;
}
