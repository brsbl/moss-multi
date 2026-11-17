import { useLayoutEffect, useRef } from 'react';
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
/** One person's initials: on their presence colour, or `neutral` (the quiet top bar: Moss's faint ink, no fill colour). */
export function AvatarChip({ avatar, neutral = false }: { avatar: Avatar; neutral?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (neutral) return;
    const apply = () => { if (ref.current) ref.current.style.color = avatarInk(getComputedStyle(ref.current).backgroundColor); };
    apply(); const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => observer.disconnect();
  }, [avatar.color, neutral]);
  return <span ref={ref} data-presence-client={avatar.clientId} data-presence-color={avatar.color} title={avatar.name + (avatar.isAgent ? ' (agent)' : '')} aria-label={avatar.name}
    className={neutral
      ? 'relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-surface-canvas text-[9px] font-normal text-ink-muted'
      : 'relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-surface-canvas text-[10px] font-semibold'}
    style={neutral ? undefined : { backgroundColor: avatar.color }}>
    {avatar.name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase()}
    {avatar.isAgent ? <Bot aria-label="Agent" className="absolute -bottom-1 -right-1 h-3 w-3 rounded bg-surface-canvas text-ink-primary" /> : null}
  </span>;
}
export function FacePile({ peers, neutral = false }: { peers: Avatar[]; neutral?: boolean }) {
  if (!peers.length) return null;
  return <div aria-label="Other people in this note" className="flex shrink-0 items-center -space-x-1">
    {peers.slice(0, 3).map(avatar => <AvatarChip key={avatar.clientId} avatar={avatar} neutral={neutral} />)}
    {peers.length > 3 ? <span className={neutral ? 'pl-1.5 text-micro text-ink-faint' : 'px-1 text-xs text-ink-muted'} title={peers.slice(3).map(peer => peer.name).join(', ')}>+{peers.length - 3}</span> : null}
  </div>;
}
