// The Suggestions button and panel (docs/design/suggestions.md §8): glyphdown's SuggestionsPanel rebuilt in moss's
// DS inside the note's top bar, beside the bell. The records are read from the note's own `suggestions` map, so a
// suggestion, an accept, a reject and a withdraw show in every window as the doc syncs; each open card's hunks come
// from the server's preview (the hash an accept must name), and a painted suggestion opens its card.
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { Popover } from '@moss/shared/primitives';
import { recordDigest, type SuggestionRecord } from '@moss-multi/core/suggest/apply';
import {
  BODY_BINDING_ATTR, DOC_ID_ATTR, EDITOR_PANE_ATTR, SUGGESTION_ACTIVE_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_ID_ATTR, SUGGESTION_ROW_ATTR, SUGGESTION_STATUS_ATTR,
  SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR, TITLE_BINDING_ATTR, TOP_BAR_ATTR, type EditMode,
} from '@moss-multi/protocol/dom-contract';
import { can, roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { readRecord, recordIds, SUGGESTIONS } from '@moss-multi/sync/suggest/records';
import { ArrowLeft, FilePenLine, MoreHorizontal, PencilLine, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import * as Y from 'yjs';
import { useDocRole } from '../../access.ts';
import { useAuthState } from '../../auth.ts';
import { sessionFetch } from '../../session-fetch.ts';
import { handOffWhenGone, HomeTrigger, useFocusHome } from '../../surfaces/footer.ts';
import { timeAgo } from '../../surfaces/NotificationsBell.tsx';
import { suggestedText } from './copy-text.ts';
import { requestMode, useShownMode } from './mode.ts';
import { placeSuggestion, type Box, type Placement } from './place.ts';
import { createPreviewLoader, useLoadedPreview, useOnScreen } from './previews.ts';
import { RowText } from './RowText.tsx';
import { usePreviewRows } from './rows.ts';

/** Reviewed cards listed under the open ones (glyphdown's cap). */
const REVIEWED_SHOWN = 20;

/** A card lists this many rows, then the rest behind "Show all"; Accept waits until every row has been shown. */
export const ROWS_SHOWN = 8;

/** What the panel needs from the pane: the note's doc while one is attached. */
export interface SuggestionsSource {
  readonly body: Y.Doc | null;
  subscribeMount(listener: () => void): () => void;
}

// Which doc's panel is open, the card a painted suggestion asked for, and where that suggestion is painted.
const openPanels = new Map<string, string | null>();
const openAt = new Map<string, () => DOMRect | null>();
const panelListeners = new Set<() => void>();
let panelVersion = 0;
const panelChanged = () => {
  panelVersion += 1;
  for (const listener of panelListeners) listener();
};

/**
 * Opens `docId`'s panel with `record`'s card active. With `at` (a click on a painted suggestion: where it is painted)
 * that one suggestion opens beside its mark, as Moss's comment thread opens at its text (T9.34).
 */
export function openSuggestion(docId: string, record: string | null, at?: () => DOMRect | null): void {
  openPanels.set(docId, record);
  if (record !== null && at) openAt.set(docId, at);
  else openAt.delete(docId);
  panelChanged();
}

function closePanel(docId: string): void {
  openAt.delete(docId);
  if (openPanels.delete(docId)) panelChanged();
}

/** Whether `docId`'s panel is open (T9.30: cues yielding around it keep their place until it closes). */
export function useSuggestionsOpen(docId: string): boolean {
  return useSyncExternalStore(subscribePanels, () => openPanels.has(docId), () => false);
}

// A Reject or Withdraw waiting for its confirmation. It is kept outside the list, so closing the list cannot drop it.
interface PendingClose {
  readonly docId: string;
  readonly action: 'reject' | 'withdraw';
  /** The author's name, or null when the person closing it wrote it. */
  readonly author: string | null;
  run(): void;
}
let pendingClose: PendingClose | null = null;
function askToClose(next: PendingClose | null): void {
  pendingClose = next;
  panelChanged();
}

/** An event the open confirmation caused: the list stays open under it. */
function fromConfirmation(docId: string, event: Event): boolean {
  if (pendingClose?.docId === docId) return true;
  // A suggestion's own menu (Withdraw) is portalled outside the list too.
  const within = (node: EventTarget | null | undefined) =>
    node instanceof Element && !!node.closest('[data-remote-web-surface-blocking-dialog], [data-moss-modal-overlay], [data-suggestion-menu]');
  return within(event.target) || within((event as FocusEvent).relatedTarget);
}

const subscribePanels = (listener: () => void) => {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
};

/** The note's records, re-read when the map changes. */
function useRecords(source: SuggestionsSource): SuggestionRecord[] {
  const body = useSyncExternalStore(source.subscribeMount, () => source.body, () => null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!body) return;
    const map = body.getMap(SUGGESTIONS);
    const changed = () => setVersion((v) => v + 1);
    map.observeDeep(changed);
    changed();
    return () => map.unobserveDeep(changed);
  }, [body]);
  return useMemo(() => {
    void version;
    if (!body) return [];
    return recordIds(body).map((id) => readRecord(body, id)).filter((record): record is SuggestionRecord => !!record && !record.meta.mergedInto);
  }, [body, version]);
}

const REASONS: Record<string, string> = {
  outdated: 'The text it changes was edited since, so it can no longer be applied.',
  broken: 'It cannot be shown in the note.',
  changed: 'It changed while you reviewed it. Look again before accepting.',
  'not-open': 'It was already reviewed.',
  'doc-cap': 'Accepting it would make the note too large.',
  'rate-limited': 'Too many reviews at once. Try again in a minute.',
  role: "You can't review this suggestion.",
  forbidden: "You can't review this suggestion.",
  unavailable: 'Its changes could not be loaded.',
};
const reasonText = (reason: string) => REASONS[reason] ?? 'It could not be applied.';

async function call(url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; retryAfter: string | null }> {
  // A role that comes from a share link travels with every call, as the comment API's does.
  const share = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('share');
  const headers: Record<string, string> = { accept: 'application/json', ...(share ? { 'x-moss-share': share } : {}) };
  const response = await sessionFetch(url, body === undefined
    ? { method: 'GET', credentials: 'same-origin', headers }
    : { method: 'POST', credentials: 'same-origin', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, json, retryAfter: response.headers.get('retry-after') };
}

// One loader for every panel: the preview budget is the reader's, across notes.
const previews = createPreviewLoader((docId, id) => call(`/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(id)}/preview`));

/** What entering Review pauses for `role` in `mode`, or what it leaves a reader able to do (T9.33). */
export function reviewEntryNote(role: Role, mode: EditMode | null): string {
  if (role === 'viewer') return 'Read proposed changes; this note stays view only';
  if (role === 'commenter') return 'Read proposed changes; you can still comment';
  return mode === 'suggest' || role === 'suggester' ? 'Suggesting pauses while you review' : 'Editing pauses while you review';
}

/** Moss's compact list action (the comment list's filter buttons): 24 px tall, as wide as its label, no resting fill. */
const ACTION = 'flex h-6 items-center rounded px-1.5 text-micro text-ink-muted transition-colors hover:bg-surface-panel hover:text-ink-default focus:outline-none focus-visible:bg-surface-panel disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted';
const ANIMATE = 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95';
const QUIET_LINK = 'shrink-0 text-micro text-ink-muted underline underline-offset-2 hover:text-ink-default';
const STATUS_WORDS: Record<string, string> = { accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' };

function SuggestionCard({ docId, record, me, role, active, single, root, opened, body }: {
  docId: string;
  /** The one suggestion opened beside its mark. */
  single: boolean;
  record: SuggestionRecord;
  me: string | null;
  role: Role | null;
  active: boolean;
  root: Element | null;
  opened: string;
  body: Y.Doc | null;
}): ReactNode {
  const { meta } = record;
  const open = meta.status === 'open';
  const [onScreenRef, onScreen] = useOnScreen(root);
  const [expanded, setExpanded] = useState(false);
  const digest = useMemo(() => `${recordDigest(record)}@${opened}`, [record, opened]);
  // Fetched again when its ops change or on refresh (the body moved under it); only while the card can be seen.
  const [preview, refresh] = useLoadedPreview(previews, docId, meta.id, digest, open && (onScreen || active || expanded));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const acceptWhy = useId();
  const cardRef = useCallback((element: HTMLDivElement | null) => {
    onScreenRef(element);
    if (active) element?.scrollIntoView({ block: 'nearest' });
  }, [active, onScreenRef]);
  const own = me !== null && meta.author === me;
  const reviewer = roleAtLeast(role, 'editor');
  const outdated = (meta.outdated?.length ?? 0) > 0 || (preview.state === 'failed' && preview.reason === 'outdated');
  const broken = !!meta.broken || (preview.state === 'failed' && preview.reason === 'broken');
  const rows = usePreviewRows(preview.state === 'ready' ? preview : null);
  // A preview that failed for any other reason is said, with a retry: Accept needs a preview.
  const failed = preview.state === 'failed' && !outdated && !broken ? reasonText(preview.reason) : null;
  const allShown = expanded || rows.length <= ROWS_SHOWN;
  const shownRows = allShown ? rows : rows.slice(0, ROWS_SHOWN);

  const act = async (action: 'accept' | 'reject' | 'withdraw') => {
    setBusy(true);
    setError(null);
    const request = action === 'accept' && preview.state === 'ready' ? { previewHash: preview.hash, digest: preview.digest } : {};
    try {
      const result = await call(`/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(meta.id)}/${action}`, request);
      if (!result.ok) {
        const reason = String(result.json.error ?? 'refused');
        setError(reasonText(reason));
        // The note changed since this preview: fetch the one an accept must now name.
        if (reason === 'changed') refresh();
      }
    } catch {
      setError('The server could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Reject and Withdraw cannot be undone, so they ask first; Accept needs every change shown instead.
  const ask = (action: 'reject' | 'withdraw') => askToClose({ docId, action, author: own ? null : meta.authorName, run: () => void act(action) });

  const status = !open ? (meta.resolvedBy === 'system' ? 'No changes' : STATUS_WORDS[meta.status] ?? meta.status) : outdated ? 'Outdated' : broken ? 'Can’t be shown' : null;

  // A flat row, as Moss's comment list draws one: author, time, the change, then its decisions.
  return (
    <div
      {...{ [SUGGESTION_CARD_ATTR]: '', [SUGGESTION_ID_ATTR]: meta.id, [SUGGESTION_STATUS_ATTR]: meta.status }}
      {...(active ? { [SUGGESTION_ACTIVE_ATTR]: '' } : {})}
      ref={cardRef}
      className={`px-3 ${single ? 'pb-2.5 pt-2' : 'py-2.5'} transition-colors ${active && !single ? 'bg-surface-panel' : ''} ${open ? '' : 'opacity-70'}`}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-1.5">
        <span className="truncate text-caption font-medium text-ink-default">{meta.authorName}{own ? ' (you)' : ''}</span>
        <span className="shrink-0 text-caption font-extralight text-ink-faint">{timeAgo(meta.createdAt)}</span>
        {status ? <span className="shrink-0 text-micro text-ink-faint">· {status}</span> : null}
        {open && own && !reviewer ? (
          // The author's own way out is secondary: Moss's comment actions menu.
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={busy}
                aria-label="Suggestion actions"
                className="-mr-1 ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus:outline-none focus-visible:bg-surface-panel focus-visible:text-ink-muted"
              >
                <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={4}
              className="min-w-32"
              data-suggestion-menu=""
              onCloseAutoFocus={(event: Event) => {
                // The confirmation takes focus (Cancel), not the trigger.
                if (pendingClose) event.preventDefault();
              }}
            >
              <DropdownMenuItem className="gap-2 text-xs text-accent-terracotta focus:text-accent-terracotta data-[highlighted]:text-accent-terracotta" onSelect={() => ask('withdraw')}>
                <Undo2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                Withdraw
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {meta.note ? <p className="mt-0.5 text-caption italic text-ink-muted">{meta.note}</p> : null}
      {open ? (
        <div className="mt-1 flex flex-col gap-0.5 text-caption">
          {preview.state === 'loading' ? <p className="text-micro text-ink-faint">Loading changes…</p> : null}
          {preview.state === 'ready' && rows.length === 0 ? <p className="text-micro text-ink-faint">No visible change yet.</p> : null}
          {failed ? (
            <div className="flex items-center gap-2">
              <span role="alert" className="text-micro text-accent-terracotta">{failed}</span>
              <button type="button" className={QUIET_LINK} onClick={refresh}>
                Try again
              </button>
            </div>
          ) : null}
          {shownRows.map((row, i) => (
            <div key={i} title={row.detail} {...{ [SUGGESTION_ROW_ATTR]: row.kind }} className="flex gap-1.5">
              {/* The operation is a small faint mark; the text keeps the note's ink, underlined or struck. */}
              <span aria-hidden className="w-2 shrink-0 text-center text-ink-faint">{row.kind === 'insert' ? '+' : row.kind === 'delete' ? '−' : '~'}</span>
              <span className={`min-w-0 whitespace-pre-wrap break-words ${row.kind === 'insert' ? 'text-ink-default' : 'text-ink-muted'}`}>
                <RowText text={row.text} struck={row.kind === 'delete'} inserted={row.kind === 'insert'} />
                {row.note ? <span className="text-micro text-ink-faint">{' — '}{row.note}</span> : null}
              </span>
            </div>
          ))}
          {allShown ? null : (
            <button type="button" className={`self-start ${QUIET_LINK}`} onClick={() => setExpanded(true)}>
              Show all {rows.length} changes
            </button>
          )}
          {(outdated || broken) ? (
            <div className="flex items-center gap-2">
              <span className="text-micro text-ink-muted">{reasonText(outdated ? 'outdated' : 'broken')}</span>
              <button
                type="button"
                className={QUIET_LINK}
                onClick={() => {
                  void navigator.clipboard?.writeText(suggestedText(record, body)).then(() => setCopied(true), () => setCopied(false));
                }}
              >
                {copied ? 'Copied' : 'Copy suggested text'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-1.5 text-micro text-accent-terracotta">{error}</p> : null}
      {open && reviewer ? (
        <div className="-ml-1.5 mt-1.5 flex gap-1">
          {allShown ? (
            <button type="button" className={ACTION} disabled={busy || preview.state !== 'ready' || outdated || broken} onClick={() => void act('accept')}>
              Accept
            </button>
          ) : (
            // A disabled button gets no pointer events: Moss's tooltip hangs on the slot around it.
            <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex rounded focus:outline-none focus-visible:bg-surface-panel" tabIndex={0} aria-describedby={acceptWhy}>
                  <button type="button" className={ACTION} disabled>
                    Accept
                  </button>
                  <span id={acceptWhy} className="sr-only">Show every change before accepting</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>Show every change before accepting</TooltipContent>
            </Tooltip>
            </TooltipProvider>
          )}
          <button type="button" className={ACTION} disabled={busy} onClick={() => ask('reject')}>
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The panel's cards: the open ones newest first, then the latest reviewed. */
export function SuggestionList({ docId, open: allOpen, reviewed: allReviewed, me, role, active, single = false, opened = '', body = null }: {
  docId: string;
  /** Only the active suggestion, opened beside its mark. */
  single?: boolean;
  open: SuggestionRecord[];
  reviewed: SuggestionRecord[];
  me: string | null;
  role: Role;
  active: string | null;
  opened?: string;
  /** The note, so a copied suggestion reads as it stands in it. */
  body?: Y.Doc | null;
}): ReactNode {
  // The scroll box the cards' visibility is measured in.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const open = single ? allOpen.filter((record) => record.meta.id === active) : allOpen;
  const reviewed = single ? allReviewed.filter((record) => record.meta.id === active) : allReviewed;
  const card = (record: SuggestionRecord) => (
    <SuggestionCard key={record.meta.id} docId={docId} record={record} me={me} role={role} active={record.meta.id === active} single={single} root={root} opened={opened} body={body} />
  );
  return (
    <div ref={setRoot} className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${single ? 'pb-1' : 'py-1'}`}>
      {single && open.length === 0 && reviewed.length === 0 ? (
        <p className="px-3 py-2.5 text-caption text-ink-faint">This suggestion is no longer in the note.</p>
      ) : null}
      {!single && open.length === 0 && reviewed.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <p className="text-xs text-ink-default">No suggestions</p>
          <p className="mt-1 text-micro text-ink-faint">
            {can(role, 'suggest') ? 'Switch to Suggest mode to propose changes. Your edits appear here for review.' : 'Suggested changes appear here for review.'}
          </p>
        </div>
      ) : null}
      {open.map(card)}
      {reviewed.length && !single ? <p className="px-3 pb-1 pt-2 text-micro text-ink-faint">Reviewed</p> : null}
      {reviewed.map(card)}
    </div>
  );
}

/** The text line boxes of `roots` between `top` and `bottom` (viewport px). */
function textLines(roots: readonly Element[], top: number, bottom: number): Box[] {
  const lines: Box[] = [];
  const range = document.createRange();
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const block = node.parentElement?.getBoundingClientRect();
      if (!block || block.bottom <= top || block.top >= bottom) continue;
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) if (line.width > 0 && line.bottom > top && line.top < bottom) lines.push(line);
    }
  }
  return lines;
}

/** Where `docId`'s suggestion opened at `mark` goes (place.ts), or null without its pane. */
const paneOf = (docId: string): Element | null => document.querySelector(`[${EDITOR_PANE_ATTR}][${DOC_ID_ATTR}="${CSS.escape(docId)}"]`);

function placeAt(docId: string, mark: DOMRect | null, height: number): Placement | null {
  const pane = paneOf(docId);
  if (!mark || !pane) return null;
  const box = pane.getBoundingClientRect();
  const bar = pane.querySelector(`[${TOP_BAR_ATTR}]`)?.getBoundingClientRect();
  const roots = [...pane.querySelectorAll(`[${TITLE_BINDING_ATTR}], [${BODY_BINDING_ATTR}]`)];
  const viewport = { width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight };
  return placeSuggestion({ mark, pane: box, barBottom: bar?.bottom ?? box.top, viewport, height, linesIn: (top, bottom) => textLines(roots, top, bottom) });
}

/** Moss's danger confirmation for a pending Reject or Withdraw on `docId`, focused on Cancel. */
function CloseConfirmation({ docId }: { docId: string }): ReactNode {
  const pending = pendingClose?.docId === docId ? pendingClose : null;
  // The copy stays while the dialog animates out.
  const shown = useRef(pending);
  if (pending) shown.current = pending;
  const reject = shown.current?.action !== 'withdraw';
  const author = shown.current?.author ?? null;
  return (
    <ConfirmationDialog
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next && pendingClose === pending) askToClose(null);
      }}
      title={reject ? 'Reject suggestion?' : 'Withdraw suggestion?'}
      description={reject
        ? `${author === null ? 'Your' : `${author}'s`} proposed change will be discarded for everyone. This action cannot be undone.`
        : 'Your proposed change will be discarded. This action cannot be undone.'}
      confirmLabel={reject ? 'Reject' : 'Withdraw'}
      cancelLabel="Cancel"
      cancelAutoFocus
      variant="danger"
      onConfirm={() => pending?.run()}
    />
  );
}

/**
 * The panel of cards, and in the top bar the count of open suggestions that opens it. The count shows only while a
 * suggestion is open and the bar has room for it (`showCount`, T9.30); More actions → Suggestions and a painted mark
 * open the same panel, at `anchor` when the count is not there. A count that opened the panel keeps its slot until
 * the panel closes; if it then leaves while it had focus, focus moves to the pane's More actions. `people` is the
 * People here action, shown in the heading once the bar has no room for it.
 */
export function SuggestionsButton({ docId, source, showCount = true, anchor, people = null }: {
  docId: string; source: SuggestionsSource; showCount?: boolean; anchor?: RefObject<HTMLElement | null>; people?: ReactNode;
}): ReactNode {
  const records = useRecords(source);
  const body = useSyncExternalStore(source.subscribeMount, () => source.body, () => null);
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  const auth = useAuthState();
  useSyncExternalStore(subscribePanels, () => panelVersion, () => 0);
  const me = auth.status === 'signed-in' ? auth.user.id : null;
  const isOpen = openPanels.has(docId);
  const active = openPanels.get(docId) ?? null;
  // Opened from a painted mark: that one suggestion, at the mark (Moss's comment thread at its text).
  const at = isOpen && active !== null ? openAt.get(docId) ?? null : null;
  // Where it goes (place.ts): beside its line while that leaves the text legible, else the pane's panel with Back to
  // note. Re-placed when the window resizes or the thread's drawn height changes; a thread that fell back to the panel
  // stays there until it is opened again, so it never flips under the reader.
  const [threadHeight, setThreadHeight] = useState(200);
  const [resized, setResized] = useState(0);
  useEffect(() => {
    if (!at) return;
    const changed = () => setResized((version) => version + 1);
    window.addEventListener('resize', changed);
    return () => window.removeEventListener('resize', changed);
  }, [at]);
  const placement = useMemo(() => {
    void resized;
    return at ? placeAt(docId, at(), threadHeight) : null;
  }, [at, docId, threadHeight, resized]);
  const [heldFor, setHeldFor] = useState<{ at: unknown; resized: number; placement: Placement } | null>(null);
  const held = heldFor && heldFor.at === at && heldFor.resized === resized ? heldFor.placement : null;
  const place = held ?? placement;
  if (at && placement && placement.kind !== 'beside' && !held) setHeldFor({ at, placement, resized });
  const markAnchor = useMemo(() => {
    // A repaint can replace the mark under it: the last place it was seen holds until the next paint.
    let last: DOMRect | null = null;
    // Read from the pane as it is now (it can still be sliding when the sidebar closes); the positioner follows the
    // pane through `contextElement`.
    const pane = paneOf(docId);
    return {
      current: {
        contextElement: pane ?? undefined,
        getBoundingClientRect: () => {
          const where = place;
          const box = pane?.getBoundingClientRect();
          const right = box ? Math.min(box.right, window.innerWidth) - 16 : where && where.kind === 'beside' ? where.right : 0;
          if (where && where.kind !== 'beside') {
            const top = box ? Math.max(pane?.querySelector(`[${TOP_BAR_ATTR}]`)?.getBoundingClientRect().bottom ?? box.top, box.top) : where.top;
            return where.kind === 'docked' ? new DOMRect(right, top + 8, 0, 0) : new DOMRect(box?.left ?? where.left, top, 0, 0);
          }
          const mark = (last = at?.() ?? last ?? new DOMRect());
          return where ? new DOMRect(right, mark.top, 0, mark.height) : mark;
        },
      },
    };
  }, [at, place, docId]);
  // The thread's drawn height, measured only while it is beside its line (a panel's height is the pane's): its header's
  // parent is the thread.
  const besideRef = useCallback((header: HTMLElement | null) => {
    const element = header?.parentElement;
    if (!element) return;
    const observer = new ResizeObserver(() => setThreadHeight(Math.ceil(element.getBoundingClientRect().height)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The note as it stood when the panel opened: a preview kept from an earlier opening is reused only if it has not moved.
  const opened = useMemo(() => (isOpen && body ? Y.encodeStateVector(body).join('.') : ''), [isOpen, body]);
  const open = records.filter((record) => record.meta.status === 'open').sort((a, b) => b.meta.createdAt - a.meta.createdAt);
  const reviewed = records
    .filter((record) => record.meta.status !== 'open')
    .sort((a, b) => (b.meta.resolvedAt ?? b.meta.createdAt) - (a.meta.resolvedAt ?? a.meta.createdAt))
    .slice(0, REVIEWED_SHOWN);
  const [pinned, setPinned] = useState(false);
  const moreActions = () => anchor?.current?.closest<HTMLElement>(`[${TOP_BAR_ATTR}]`)?.querySelector<HTMLElement>('button[aria-label="More actions"]') ?? null;
  // A focused count that leaves, unopened, hands focus to More actions, where Suggestions stays.
  const focusHome = useFocusHome(moreActions);
  const entryNote = useId();
  const shown = showCount && open.length > 0;
  if (isOpen && shown && !pinned) setPinned(true);
  if (!isOpen && pinned) setPinned(false);
  if (role === null) return null;
  const reviewing = mode === 'review';
  // While the panel is open the count it opened from stays, even when the pane narrows or the last suggestion closes.
  const counted = shown || (isOpen && pinned);
  // The list hangs from its count or More actions; a suggestion opened at its mark goes where place.ts put it.
  const contentPlacement = !at
    ? ({ side: 'bottom', align: 'end', sideOffset: 6 } as const)
    : !place || place.kind === 'beside'
      ? ({ side: place?.side ?? 'bottom', align: place ? 'end' : 'start', sideOffset: 8 } as const)
      : ({ side: 'bottom', align: place.kind === 'docked' ? 'end' : 'start', sideOffset: 0 } as const);
  const surfaceClass = place?.kind === 'pane'
    // The pane's own single view: the note's canvas, no card.
    ? 'bg-surface-canvas'
    : `border border-border-subtle bg-surface-floating ${ANIMATE} ${!at || place?.kind === 'docked' ? 'rounded-lg shadow-surface' : 'rounded-xl shadow-sm'} ${place ? '' : 'w-comment-list-popover max-w-floating-popover-viewport'}`;
  return (
    <TooltipProvider>
      <Popover.Root
        open={isOpen}
        onOpenChange={(next) => {
          if (next) openSuggestion(docId, null);
          else {
            closePanel(docId);
            // The count that opened the list leaves its slot once the list closes: focus goes to More actions.
            const bar = anchor?.current?.closest<HTMLElement>(`[${TOP_BAR_ATTR}]`);
            if (pinned && bar) handOffWhenGone(bar, `[${SUGGESTIONS_BUTTON_ATTR}]`, moreActions);
          }
        }}
      >
        {counted ? (
          <Tooltip>
            <HomeTrigger asChild ref={focusHome}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  data-collab-chrome=""
                  {...{ [SUGGESTIONS_BUTTON_ATTR]: String(open.length) }}
                  aria-label={open.length ? `Suggestions, ${open.length} open` : 'Suggestions'}
                  aria-haspopup="dialog"
                  aria-expanded={isOpen}
                  className="relative flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
                >
                  <FilePenLine aria-hidden className="h-3.5 w-3.5" />
                  {open.length ? <span className="text-micro tabular-nums">{open.length}</span> : null}
                </button>
              </Popover.Trigger>
            </HomeTrigger>
            <TooltipContent side="bottom">Suggestions</TooltipContent>
          </Tooltip>
        ) : null}
        {/* Radix measures a virtual anchor only through getBoundingClientRect. */}
        {at ? <Popover.Anchor virtualRef={markAnchor as unknown as RefObject<Element | null>} /> : !counted && anchor ? <Popover.Anchor virtualRef={anchor} /> : null}
        <Popover.Portal>
          <Popover.Content
            {...contentPlacement}
            avoidCollisions={!at}
            // The pane's single view is the pane's own size: no margin to keep from the screen's edge.
            collisionPadding={place?.kind === 'pane' ? 0 : 16}
            // Never taller than its room: its rows scroll and its decisions and close stay reachable.
            style={{ maxHeight: place ? `${place.maxHeight}px` : 'min(60vh, var(--available-height, 60vh))', ...(place ? { width: `${place.width}px` } : {}), ...(place?.kind === 'pane' ? { height: `${place.maxHeight}px` } : {}) }}
            className={`z-50 flex flex-col overflow-hidden outline-none focus:outline-none focus-visible:ring-0 ${surfaceClass}`}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => { if (fromConfirmation(docId, event)) event.preventDefault(); }}
            onFocusOutside={(event) => { if (fromConfirmation(docId, event)) event.preventDefault(); }}
            onEscapeKeyDown={(event) => { if (fromConfirmation(docId, event)) event.preventDefault(); }}
            {...{ [SUGGESTIONS_PANEL_ATTR]: '' }}
            {...(place ? { 'data-suggestion-place': place.kind } : {})}
          >
            {at ? (
              // Moss's comment thread header: what it is and its close, or, as the pane's panel, the way back.
              <div ref={place?.kind === 'beside' ? besideRef : undefined} className="flex shrink-0 items-center justify-between gap-1 border-b border-border-subtle/30 px-2 py-1.5">
                {place && place.kind !== 'beside' ? (
                  <>
                  <Popover.Title className="sr-only">Suggestion</Popover.Title>
                  <button type="button" className={`-ml-0.5 gap-1 ${ACTION}`} onClick={() => closePanel(docId)}>
                    <ArrowLeft aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Back to note
                  </button>
                  </>
                ) : (
                  <>
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      <PencilLine aria-hidden className="ml-1 mr-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={1.5} />
                      <Popover.Title className="truncate text-caption font-normal text-ink-faint">Suggestion</Popover.Title>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Close"
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                          onClick={() => closePanel(docId)}
                        >
                          <X className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>Close</TooltipContent>
                    </Tooltip>
                  </>
                )}
              </div>
            ) : null}
            {at ? null : <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border-subtle bg-surface-raised-control px-2 py-1.5">
              <Popover.Title className="sr-only">Suggestions</Popover.Title>
              <div className="flex min-w-0 items-center gap-1">
                <PencilLine aria-hidden className="ml-1 mr-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" strokeWidth={1.5} />
                {open.length ? <span className="text-micro tabular-nums text-ink-faint">{open.length} open</span> : null}
              </div>
              {people ? <div className="ml-auto flex shrink-0 items-center">{people}</div> : null}
            </div>}
            {open.length && !reviewing && !at ? (
              // The way into Review, saying what it pauses; in Review the pane's bottom row is its one state and exit.
              <button
                type="button"
                aria-label="Review suggestions"
                aria-describedby={entryNote}
                className="mx-1 mt-1 flex shrink-0 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-note-hover focus:outline-none focus-visible:bg-surface-note-hover"
                onClick={() => {
                  requestMode(docId, 'review');
                  closePanel(docId);
                }}
              >
                <span className="text-xs text-ink-default">Review suggestions</span>
                <span id={entryNote} className="text-micro text-ink-faint">{reviewEntryNote(role, mode)}</span>
              </button>
            ) : null}
            <SuggestionList docId={docId} open={open} reviewed={reviewed} me={me} role={role} active={active} single={at !== null} opened={opened} body={body} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <CloseConfirmation docId={docId} />
    </TooltipProvider>
  );
}
