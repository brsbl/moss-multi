// The note's top-bar cues (T9.30), at the start of Moss's right group in this order: People here, the unread bell and
// the open-suggestions count. Each shows only while it has something to say; at rest the bar is Moss's own. They yield
// by the pane's width, never by measuring themselves, so Moss's actions always keep their place: People here folds to
// one target, then the bell leaves (the inbox stays in the sidebar's app menu), then the count (it stays in More
// actions → Suggestions), then People here moves into the Suggestions list's heading. An open popup keeps its
// activator until it closes.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { TOP_BAR_ATTR } from '@moss-multi/protocol/dom-contract';
import { Bot, Users } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { FacePile, type Avatar } from '../../../../../packages/ui/src/FacePile.tsx';
import { ConnectionIndicator } from '../collab/ConnectionNotice.tsx';
import { usePeers } from '../collab/presence.ts';
import { SuggestionsButton, type SuggestionsSource } from '../collab/suggest/SuggestionsPanel.tsx';
import { useFocusHome } from './footer.ts';
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

const peopleLabel = (peers: Avatar[]): string => {
  const agents = peers.filter((peer) => peer.isAgent).length;
  const people = peers.length - agents;
  const parts = [people ? `${people} other ${people === 1 ? 'person' : 'people'}` : '', agents ? `${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''];
  return `People here, ${parts.filter(Boolean).join(', ')}`;
};

/**
 * Others in the note: their initials, or one Users target when the bar is narrow; either opens the list of names.
 * `pinned` reports while its list is open, so the bar keeps it in its slot until the list closes.
 */
export function PeopleHere({ docId, compact, onOpenChange, home }: {
  docId: string; compact: boolean; onOpenChange?: (open: boolean) => void; home?: () => HTMLElement | null;
}): ReactNode {
  const peers = usePeers(docId);
  const focusHome = useFocusHome(home ?? (() => null));
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  if (peers.length === 0) return null;
  const label = peopleLabel(peers);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild ref={focusHome} /* Moss's asChild drops a child's own ref */>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-collab-chrome=""
                aria-label={label}
                className="flex h-7 min-w-[28px] shrink-0 cursor-pointer items-center justify-center rounded px-0.5 text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
              >
                {compact ? <Users aria-hidden className="h-3.5 w-3.5" /> : <FacePile peers={peers} neutral />}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {open ? null : <TooltipContent side="bottom">People here</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" side="bottom" sideOffset={6} collisionPadding={16} className="max-h-80 min-w-0 w-max max-w-[calc(100vw-2rem)] overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-ink-faint">People here</DropdownMenuLabel>
        {peers.map((peer) => (
          <DropdownMenuItem key={peer.clientId} className="gap-2 text-xs">
            {peer.isAgent ? <Bot aria-hidden className="h-3.5 w-3.5 text-ink-faint" /> : null}
            <span className="min-w-0 flex-1 truncate">{peer.name}</span>
            {peer.isAgent ? <span className="text-ink-faint">agent</span> : null}
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
