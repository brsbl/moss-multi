// The Suggestions button and panel (docs/design/suggestions.md §8): glyphdown's SuggestionsPanel rebuilt in moss's
// DS inside the note's top bar, beside the bell. The records are read from the note's own `suggestions` map, so a
// suggestion, an accept, a reject and a withdraw show in every window as the doc syncs; each open card's hunks come
// from the server's preview (the hash an accept must name), and a painted suggestion opens its card.
import { Button } from '@moss/shared/components/ui/button';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { Popover } from '@moss/shared/primitives';
import { recordDigest, type SuggestionRecord } from '@moss-multi/core/suggest/apply';
import {
  SUGGESTION_ACTIVE_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_ID_ATTR, SUGGESTION_ROW_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR,
} from '@moss-multi/protocol/dom-contract';
import { can, roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { readRecord, recordIds, SUGGESTIONS } from '@moss-multi/sync/suggest/records';
import { Check, PencilLine, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as Y from 'yjs';
import { useDocRole } from '../../access.ts';
import { useAuthState } from '../../auth.ts';
import { timeAgo } from '../../surfaces/NotificationsBell.tsx';
import { suggestedText } from './copy-text.ts';
import { requestMode, useShownMode } from './mode.ts';
import { createPreviewLoader, useLoadedPreview, useOnScreen } from './previews.ts';
import { RowText } from './RowText.tsx';
import { leaveReview } from './SuggestChrome.tsx';
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

// Which doc's panel is open, and the card a painted suggestion asked for.
const openPanels = new Map<string, string | null>();
const panelListeners = new Set<() => void>();
let panelVersion = 0;
const panelChanged = () => {
  panelVersion += 1;
  for (const listener of panelListeners) listener();
};

/** Opens `docId`'s panel with `record`'s card active (a click on a painted suggestion). */
export function openSuggestion(docId: string, record: string | null): void {
  openPanels.set(docId, record);
  panelChanged();
}

function closePanel(docId: string): void {
  if (openPanels.delete(docId)) panelChanged();
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
  const within = (node: EventTarget | null | undefined) =>
    node instanceof Element && !!node.closest('[data-remote-web-surface-blocking-dialog], [data-moss-modal-overlay]');
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
  const response = await fetch(url, body === undefined
    ? { method: 'GET', credentials: 'same-origin', headers }
    : { method: 'POST', credentials: 'same-origin', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, json, retryAfter: response.headers.get('retry-after') };
}

// One loader for every panel: the preview budget is the reader's, across notes.
const previews = createPreviewLoader((docId, id) => call(`/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(id)}/preview`));

const BADGE = 'inline-flex items-center rounded px-1.5 py-0.5 text-micro';

function SuggestionCard({ docId, record, me, role, active, root, opened, body }: {
  docId: string;
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

  return (
    <div
      {...{ [SUGGESTION_CARD_ATTR]: '', [SUGGESTION_ID_ATTR]: meta.id, [SUGGESTION_STATUS_ATTR]: meta.status }}
      {...(active ? { [SUGGESTION_ACTIVE_ATTR]: '' } : {})}
      ref={cardRef}
      className={`rounded-lg border p-2.5 transition-colors ${active ? 'border-accent-brand shadow-sm' : 'border-border-subtle'} ${open ? '' : 'opacity-70'}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-ink-default">{meta.authorName}{own ? ' (you)' : ''}</span>
        <span className="text-micro text-ink-faint">{timeAgo(meta.createdAt)}</span>
        {!open ? <span className={`${BADGE} bg-surface-badge text-ink-muted`}>{meta.resolvedBy === 'system' ? 'no changes' : meta.status}</span> : null}
        {open && outdated ? <span className={`${BADGE} bg-surface-badge text-accent-terracotta`}>outdated</span> : null}
        {open && broken && !outdated ? <span className={`${BADGE} bg-surface-badge text-accent-terracotta`}>broken</span> : null}
      </div>
      {meta.note ? <p className="mb-1.5 text-sm italic text-ink-muted">{meta.note}</p> : null}
      {open ? (
        <div className="flex flex-col gap-1 text-xs">
          {preview.state === 'loading' ? <p className="text-micro text-ink-faint">Loading changes…</p> : null}
          {preview.state === 'ready' && rows.length === 0 ? <p className="text-micro text-ink-faint">No visible change yet.</p> : null}
          {failed ? (
            <div className="flex items-center gap-2">
              <span role="alert" className="text-micro text-accent-terracotta">{failed}</span>
              <button type="button" className="shrink-0 text-micro text-ink-default underline" onClick={refresh}>
                Try again
              </button>
            </div>
          ) : null}
          {shownRows.map((row, i) => (
            <div
              key={i}
              title={row.detail}
              {...{ [SUGGESTION_ROW_ATTR]: row.kind }}
              className={`flex gap-1 rounded px-1.5 py-0.5 ${row.kind === 'insert' ? 'bg-accent-brand/10 text-accent-brand-pressed' : row.kind === 'delete' ? 'bg-accent-terracotta/10 text-accent-terracotta' : 'bg-surface-badge text-ink-muted'}`}
            >
              <span aria-hidden className="shrink-0">{row.kind === 'insert' ? '+' : row.kind === 'delete' ? '−' : '~'}</span>
              <span className="min-w-0 whitespace-pre-wrap break-words">
                <RowText text={row.text} struck={row.kind === 'delete'} />
                {row.note ? <span className="text-micro text-ink-faint">{' — '}{row.note}</span> : null}
              </span>
            </div>
          ))}
          {allShown ? null : (
            <button type="button" className="self-start text-micro text-ink-default underline" onClick={() => setExpanded(true)}>
              Show all {rows.length} changes
            </button>
          )}
          {(outdated || broken) ? (
            <div className="flex items-center gap-2">
              <span className="text-micro text-ink-muted">{reasonText(outdated ? 'outdated' : 'broken')}</span>
              <button
                type="button"
                className="shrink-0 text-micro text-ink-default underline"
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
      {open && (reviewer || own) ? (
        <div className="mt-2 flex gap-2">
          {reviewer ? (
            <>
              <Button size="sm" className="h-7 gap-1 px-2 text-xs" disabled={busy || preview.state !== 'ready' || !allShown || outdated || broken}
                title={allShown ? undefined : 'Show every change before accepting'}
                onClick={() => void act('accept')}>
                <Check aria-hidden className="h-3 w-3" />
                Accept
              </Button>
              <Button size="sm" variant="secondary" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={() => ask('reject')}>
                <X aria-hidden className="h-3 w-3" />
                Reject
              </Button>
            </>
          ) : null}
          {own && !reviewer ? (
            <Button size="sm" variant="secondary" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={() => ask('withdraw')}>
              <X aria-hidden className="h-3 w-3" />
              Withdraw
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The panel's cards: the open ones newest first, then the latest reviewed. */
export function SuggestionList({ docId, open, reviewed, me, role, active, opened = '', body = null }: {
  docId: string;
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
  return (
    <div ref={setRoot} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      {open.length === 0 && reviewed.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <p className="text-xs text-ink-default">No suggestions</p>
          <p className="mt-1 text-micro text-ink-faint">
            {can(role, 'suggest') ? 'Switch to Suggest mode to propose changes. Your edits appear here for review.' : 'Suggested changes appear here for review.'}
          </p>
        </div>
      ) : null}
      {open.map((record) => (
        <SuggestionCard key={record.meta.id} docId={docId} record={record} me={me} role={role} active={record.meta.id === active} root={root} opened={opened} body={body} />
      ))}
      {reviewed.length ? <p className="mt-1 px-1 text-micro font-medium uppercase tracking-wide text-ink-faint">Reviewed</p> : null}
      {reviewed.map((record) => (
        <SuggestionCard key={record.meta.id} docId={docId} record={record} me={me} role={role} active={record.meta.id === active} root={root} opened={opened} body={body} />
      ))}
    </div>
  );
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

/** In the top bar: the count of open suggestions, opening the panel of cards. */
export function SuggestionsButton({ docId, source }: { docId: string; source: SuggestionsSource }): ReactNode {
  const records = useRecords(source);
  const body = useSyncExternalStore(source.subscribeMount, () => source.body, () => null);
  const role = useDocRole(docId);
  const mode = useShownMode(docId);
  const auth = useAuthState();
  useSyncExternalStore(subscribePanels, () => panelVersion, () => 0);
  const me = auth.status === 'signed-in' ? auth.user.id : null;
  const isOpen = openPanels.has(docId);
  const active = openPanels.get(docId) ?? null;
  // The note as it stood when the panel opened: a preview kept from an earlier opening is reused only if it has not moved.
  const opened = useMemo(() => (isOpen && body ? Y.encodeStateVector(body).join('.') : ''), [isOpen, body]);
  const open = records.filter((record) => record.meta.status === 'open').sort((a, b) => b.meta.createdAt - a.meta.createdAt);
  const reviewed = records
    .filter((record) => record.meta.status !== 'open')
    .sort((a, b) => (b.meta.resolvedAt ?? b.meta.createdAt) - (a.meta.resolvedAt ?? a.meta.createdAt))
    .slice(0, REVIEWED_SHOWN);
  // Shown once the note has any suggestion, open or reviewed, as Moss shows its Comments button (comment-entry-point).
  if (role === null) return null;
  const reviewing = mode === 'review';
  return (
    <TooltipProvider>
      <Popover.Root open={isOpen} onOpenChange={(next) => (next ? openSuggestion(docId, null) : closePanel(docId))}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Popover.Trigger asChild>
              <button
                type="button"
                data-collab-chrome=""
                {...{ [SUGGESTIONS_BUTTON_ATTR]: String(open.length) }}
                aria-label={open.length ? `Suggestions, ${open.length} open` : 'Suggestions'}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                className={`relative ${open.length || isOpen ? 'flex' : 'hidden'} h-7 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none`}
              >
                <PencilLine aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
                <span className="sr-only">{open.length} open</span>
              </button>
            </Popover.Trigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Suggestions</TooltipContent>
        </Tooltip>
        <Popover.Portal>
          <Popover.Content
            align="end"
            side="bottom"
            sideOffset={6}
            collisionPadding={16}
            className="z-50 flex max-h-comment-list-popover w-comment-list-popover max-w-floating-popover-viewport flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-floating shadow-surface outline-none focus:outline-none focus-visible:ring-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => { if (fromConfirmation(docId, event)) event.preventDefault(); }}
            onFocusOutside={(event) => { if (fromConfirmation(docId, event)) event.preventDefault(); }}
            onEscapeKeyDown={(event) => { if (fromConfirmation(docId, event)) event.preventDefault(); }}
            {...{ [SUGGESTIONS_PANEL_ATTR]: '' }}
          >
            <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border-subtle bg-surface-raised-control px-2 py-1.5">
              <Popover.Title className="sr-only">Suggestions</Popover.Title>
              <div className="flex min-w-0 items-center gap-1">
                <PencilLine aria-hidden className="ml-1 mr-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" strokeWidth={1.5} />
                {open.length ? <span className="text-micro tabular-nums text-ink-faint">{open.length} open</span> : null}
              </div>
              {open.length ? (
                <button
                  type="button"
                  aria-pressed={reviewing}
                  className={`flex h-6 items-center gap-1 rounded px-1.5 text-micro transition-colors focus:outline-none focus-visible:ring-0 ${reviewing ? 'bg-surface-panel text-ink-default' : 'text-ink-faint hover:bg-surface-panel hover:text-ink-muted'}`}
                  onClick={() => {
                    if (reviewing) leaveReview(docId, role);
                    else requestMode(docId, 'review');
                    closePanel(docId);
                  }}
                >
                  {reviewing ? 'Done reviewing' : 'Review changes…'}
                </button>
              ) : null}
            </div>
            <SuggestionList docId={docId} open={open} reviewed={reviewed} me={me} role={role} active={active} opened={opened} body={body} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <CloseConfirmation docId={docId} />
    </TooltipProvider>
  );
}
