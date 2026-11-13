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
  return <TooltipProvider><Tooltip><TooltipTrigger asChild>
    <button type="button" data-presence-client={avatar.clientId} data-presence-color={avatar.color}
      aria-label={avatar.name + (avatar.isAgent ? ' (agent)' : '')}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-micro font-normal text-ink-faint hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
      {avatar.isAgent ? <Bot aria-hidden className="h-3.5 w-3.5" /> : avatar.name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()}
    </button>
  </TooltipTrigger><TooltipContent side="bottom">{avatar.name}{avatar.isAgent ? ' · Agent' : ''}</TooltipContent></Tooltip></TooltipProvider>;
}

export function FacePile({ peers }: { peers: Avatar[] }) {
  if (!peers.length) return null;
  return <div aria-label="Other people in this note" className="flex shrink-0 items-center gap-0.5">
    {peers.slice(0, 3).map(avatar => <AvatarChip key={avatar.clientId} avatar={avatar} />)}
    {peers.length > 3 ? <span tabIndex={0} className="px-1 text-xs text-ink-muted" title={peers.slice(3).map(peer => peer.name).join(', ')}>+{peers.length - 3}</span> : null}
  </div>;
}
