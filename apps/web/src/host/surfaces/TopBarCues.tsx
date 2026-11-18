// The note's top-bar cues (T9.30), at the start of Moss's right group in this order: People here, the unread bell and
// the open-suggestions count. Each shows only while it has something to say; at rest the bar is Moss's own. They yield
// by the pane's width, never by measuring themselves, so Moss's actions always keep their place: People here folds to
// one target, then the bell leaves (the inbox stays in the sidebar's app menu), then the count (it stays in More
// actions → Suggestions), then People here moves into the Suggestions list's heading. An open popup keeps its
// activator until it closes.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider } from '@moss/shared/components/ui/tooltip';
import { TOP_BAR_ATTR } from '@moss-multi/protocol/dom-contract';
import { Users } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { FacePile, type Avatar } from '../../../../../packages/ui/src/FacePile.tsx';
import { ConnectionIndicator } from '../collab/ConnectionNotice.tsx';
import { inspect, usePeers, useUnplacedTyping } from '../collab/presence.ts';
import { SuggestionsButton, type SuggestionsSource } from '../collab/suggest/SuggestionsPanel.tsx';
import { HomeTrigger, useFocusHome } from './footer.ts';
import { NotificationsBell } from './NotificationsBell.tsx';

/** Pane widths (CSS px) below which each cue yields, in order. */
export const YIELD_AT = { people: 880, bell: 760, count: 700, peopleOut: 640 } as const;

const Menu = DropdownMenu as ComponentType<{ children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }>;

/** The width of the top bar holding `probe`, followed as the pane resizes; Infinity until measured. */
function usePaneWidth(probe: { current: HTMLElement | null }, bar: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const element = probe.current?.parentElement?.closest<HTMLElement>(`[${TOP_BAR_ATTR}]`) ?? null;
    bar.current = element;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [probe, bar]);
  return width;
}

/** “People here, N other sessions, A agents”: every other window counts, an agent's too (T9.32). */
export const peopleLabel = (peers: Avatar[]): string => {
  const agents = peers.filter((peer) => peer.isAgent).length;
  const sessions = `${peers.length} other ${peers.length === 1 ? 'session' : 'sessions'}`;
  return `People here, ${sessions}${agents ? `, ${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''}`;
};

/**
 * Others in the note: their initials, or one Users target when the bar is narrow; either opens the list of names.
 * While someone types with no room for their name beside the text, the same button reads “N typing” and its list
 * starts with them. `onOpenChange` reports while its list is open, so the bar keeps it in its slot until it closes.
 */
export function PeopleHere({ docId, compact, onOpenChange, home }: {
  docId: string; compact: boolean; onOpenChange?: (open: boolean) => void; home?: () => HTMLElement | null;
}): ReactNode {
  const peers = usePeers(docId);
  const typingIds = useUnplacedTyping(docId);
  const focusHome = useFocusHome(home ?? (() => null));
  const [open, setOpenState] = useState(false);
  // The sessions listed first: those typing unseen when the list opened. Kept while it is open, so rows hold still.
  const [first, setFirst] = useState<number[]>([]);
  const setOpen = (next: boolean) => {
    if (next) setFirst(typingIds);
    else inspect(docId, null);
    setOpenState(next);
    onOpenChange?.(next);
  };
  useEffect(() => () => inspect(docId, null), [docId]);
  if (peers.length === 0) return null;
  const typing = peers.filter((peer) => typingIds.includes(peer.clientId));
  const label = peopleLabel(peers) + (typing.length ? `; typing: ${typing.map((peer) => peer.label).join(', ')}` : '');
  const rows = [...peers.filter((peer) => first.includes(peer.clientId)), ...peers.filter((peer) => !first.includes(peer.clientId))];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <HomeTrigger asChild ref={focusHome}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-collab-chrome=""
                aria-label={label}
                className="flex h-7 min-w-[28px] shrink-0 cursor-pointer items-center justify-center rounded px-0.5 text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
              >
                {typing.length
                  ? <span aria-hidden className="whitespace-nowrap px-1 text-xs text-ink-muted">{typing.length} typing</span>
                  : compact ? <Users aria-hidden className="h-3.5 w-3.5" /> : <FacePile peers={peers} />}
              </button>
            </DropdownMenuTrigger>
          </HomeTrigger>
          {open ? null : <TooltipContent side="bottom">{typing.length ? typing.map((peer) => peer.label).join(', ') : 'People here'}</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" side="bottom" sideOffset={6} collisionPadding={16} className="max-h-80 min-w-0 w-max max-w-[min(20rem,calc(100vw-2rem))] overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-ink-faint">People here</DropdownMenuLabel>
        {rows.map((peer) => (
          // Focus, hover or a tap names this person at their caret; nothing scrolls and the local caret stays put. A
          // tap keeps the list open, so it is an inspection, not an action; Escape or a click outside ends it.
          <DropdownMenuItem
            key={peer.clientId}
            className="gap-2 text-xs"
            onFocus={() => inspect(docId, peer.clientId)}
            onSelect={(event: Event) => { event.preventDefault(); inspect(docId, peer.clientId); }}
          >
            <span aria-hidden data-presence-swatch="" data-presence-color={peer.color} className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: peer.color }} />
            <span className="min-w-0 flex-1 truncate">{peer.label}</span>
            {peer.isAgent ? <span className="text-ink-faint">Bot</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </Menu>
  );
}

/** The cues, and the pane's connection published for the DOM contract (it draws nothing). */
export function TopBarCues({ docId, suggestions }: { docId: string; suggestions: SuggestionsSource | null }): ReactNode {
  const probe = useRef<HTMLSpanElement | null>(null);
  const bar = useRef<HTMLElement | null>(null);
  const width = usePaneWidth(probe, bar);
  const [peopleOpen, setPeopleOpen] = useState(false);
  // Below 640 px of pane People here leaves the bar for the Suggestions list's heading; an open roster stays put.
  const peopleInBar = width >= YIELD_AT.peopleOut || peopleOpen || !suggestions;
  // Focused when it leaves the bar, People here hands focus to More actions, whose Suggestions list holds it now.
  const moreActions = () => bar.current?.querySelector<HTMLElement>('button[aria-label="More actions"]') ?? null;
  return (
    <>
      <span ref={probe} hidden />
      {peopleInBar ? <PeopleHere docId={docId} compact={width < YIELD_AT.people} onOpenChange={setPeopleOpen} home={moreActions} /> : null}
      <NotificationsBell show={width >= YIELD_AT.bell} bar={bar} />
      {suggestions ? (
        <SuggestionsButton
          docId={docId}
          source={suggestions}
          showCount={width >= YIELD_AT.count}
          anchor={bar}
          people={peopleInBar ? null : <PeopleHere docId={docId} compact />}
        />
      ) : null}
      <ConnectionIndicator docId={docId} />
    </>
  );
}
