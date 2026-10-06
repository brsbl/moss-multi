// The Suggestions button and panel (docs/design/suggestions.md §8): glyphdown's SuggestionsPanel rebuilt in moss's
// DS inside the note's top bar, beside the bell. The records are read from the note's own `suggestions` map, so a
// suggestion, an accept, a reject and a withdraw show in every window as the doc syncs; each open card's hunks come
// from the server's preview (the hash an accept must name), and a painted suggestion opens its card.
import { Button } from '@moss/shared/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { BODY_DOC, recordDigest, type Hunk, type SuggestionRecord } from '@moss-multi/core/suggest/apply';
import {
  SUGGESTION_ACTIVE_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_ID_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR,
} from '@moss-multi/protocol/dom-contract';
import { can, roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { readRecord, recordIds, SUGGESTIONS } from '@moss-multi/sync/suggest/records';
import { Check, GitPullRequestArrow, X } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as Y from 'yjs';
import { useDocRole } from '../../access.ts';
import { useAuthState } from '../../auth.ts';
import { timeAgo } from '../../surfaces/NotificationsBell.tsx';

/** Reviewed cards listed under the open ones (glyphdown's cap). */
const REVIEWED_SHOWN = 20;
/** Excerpts a card shows before "…and N more changes". */
const EXCERPTS = 3;

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

/** A block's or payload's visible text, from the projection a hunk carries. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if ('lexical' in record && record.lexical) return textOf(record.lexical);
  if (typeof record.text === 'string') return record.text;
  if (Array.isArray(record.children)) return record.children.map(textOf).join(record.type === 'root' ? '\n' : '');
  if (typeof record.code === 'string') return record.code;
  if ('y' in record) return textOf(record.y);
  if (Array.isArray(record.seq)) return record.seq.map(textOf).join('');
  return '';
}

interface Excerpt {
  kind: 'insert' | 'delete' | 'change';
  text: string;
}

/** The changed middle of two texts: what was removed and what was added. */
function middle(before: string, after: string): { removed: string; added: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { removed: before.slice(start, before.length - end), added: after.slice(start, after.length - end) };
}

/** Each hunk as glyphdown's `+` and `−` excerpts. */
export function excerptsOf(hunks: readonly Hunk[]): Excerpt[] {
  const out: Excerpt[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === 'note') {
      out.push({ kind: 'change', text: 'Note settings' });
      continue;
    }
    const before = hunk.op === 'added' ? '' : textOf(hunk.before);
    const after = hunk.op === 'removed' ? '' : textOf(hunk.after);
    const { removed, added } = middle(before, after);
    if (removed.trim()) out.push({ kind: 'delete', text: removed });
    if (added.trim()) out.push({ kind: 'insert', text: added });
    if (!removed.trim() && !added.trim()) out.push({ kind: 'change', text: hunk.kind === 'payload' ? 'Block content' : before.trim() ? `Formatting: ${before.trim()}` : 'A new block' });
  }
  return out;
}

/** The text a record would add, decoded from its own ops (§4.7 "Copy suggested text"). */
export function suggestedText(record: SuggestionRecord): string {
  const parts: string[] = [];
  for (const op of record.ops) {
    try {
      for (const struct of Y.decodeUpdate(op.update).structs) {
        if (struct instanceof Y.Item && struct.content instanceof Y.ContentString) parts.push(struct.content.str);
      }
    } catch {
      // An undecodable op adds nothing to copy.
    }
    if (op.doc !== BODY_DOC) parts.push('\n');
  }
  return parts.join('').trim();
}

type Preview = { state: 'loading' } | { state: 'ready'; hunks: Hunk[]; hash: string; digest: string } | { state: 'failed'; reason: string };

const REASONS: Record<string, string> = {
  outdated: 'The text it changes was edited since, so it can no longer be applied.',
  broken: 'It cannot be shown in the note.',
  changed: 'It changed while you reviewed it. Look again before accepting.',
  'not-open': 'It was already reviewed.',
  'doc-cap': 'Accepting it would make the note too large.',
  'rate-limited': 'Too many reviews at once. Try again in a minute.',
  role: "You can't review this suggestion.",
  forbidden: "You can't review this suggestion.",
};
const reasonText = (reason: string) => REASONS[reason] ?? 'It could not be applied.';

async function call(url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, json };
}

function usePreview(docId: string, record: SuggestionRecord, enabled: boolean): Preview {
  const digest = useMemo(() => recordDigest(record), [record]);
  const [preview, setPreview] = useState<{ digest: string; value: Preview }>({ digest: '', value: { state: 'loading' } });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Debounced, so an author still typing costs one preview per pause.
    const timer = setTimeout(() => {
      void call(`/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(record.meta.id)}/preview`).then(
        ({ ok, json }) => {
          if (!live) return;
          const shown = json.preview as { hunks: Hunk[]; hash: string; digest: string } | undefined;
          setPreview({ digest, value: ok && shown ? { state: 'ready', ...shown } : { state: 'failed', reason: String(json.error ?? 'unavailable') } });
        },
        () => live && setPreview({ digest, value: { state: 'failed', reason: 'unavailable' } }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [docId, record.meta.id, digest, enabled]);
  return preview.digest === digest ? preview.value : { state: 'loading' };
}

const BADGE = 'inline-flex items-center rounded-md px-1.5 py-0.5 text-micro';

function SuggestionCard({ docId, record, me, role, active }: { docId: string; record: SuggestionRecord; me: string | null; role: Role | null; active: boolean }): ReactNode {
  const { meta } = record;
  const open = meta.status === 'open';
  const preview = usePreview(docId, record, open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const own = me !== null && meta.author === me;
  const reviewer = roleAtLeast(role, 'editor');
  const outdated = (meta.outdated?.length ?? 0) > 0 || (preview.state === 'failed' && preview.reason === 'outdated');
  const broken = !!meta.broken || (preview.state === 'failed' && preview.reason === 'broken');
  const excerpts = preview.state === 'ready' ? excerptsOf(preview.hunks) : [];

  const act = async (action: 'accept' | 'reject' | 'withdraw') => {
    setBusy(true);
    setError(null);
    const body = action === 'accept' && preview.state === 'ready' ? { previewHash: preview.hash, digest: preview.digest } : {};
    try {
      const result = await call(`/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(meta.id)}/${action}`, body);
      if (!result.ok) setError(reasonText(String(result.json.error ?? 'refused')));
    } catch {
      setError('The server could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      {...{ [SUGGESTION_CARD_ATTR]: '', [SUGGESTION_ID_ATTR]: meta.id, [SUGGESTION_STATUS_ATTR]: meta.status }}
      {...(active ? { [SUGGESTION_ACTIVE_ATTR]: '' } : {})}
      ref={(element) => {
        if (active) element?.scrollIntoView({ block: 'nearest' });
      }}
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
          {preview.state === 'ready' && excerpts.length === 0 ? <p className="text-micro text-ink-faint">No visible change yet.</p> : null}
          {excerpts.slice(0, EXCERPTS).map((excerpt, i) => (
            <p
              key={i}
              className={`m-0 truncate rounded px-1.5 py-0.5 ${excerpt.kind === 'insert' ? 'bg-accent-brand/10 text-accent-brand-pressed' : excerpt.kind === 'delete' ? 'bg-accent-terracotta/10 text-accent-terracotta line-through' : 'bg-surface-badge text-ink-muted'}`}
            >
              {excerpt.kind === 'insert' ? '+ ' : excerpt.kind === 'delete' ? '− ' : '~ '}
              {excerpt.text.trim()}
            </p>
          ))}
          {excerpts.length > EXCERPTS ? <p className="m-0 text-micro text-ink-faint">…and {excerpts.length - EXCERPTS} more changes</p> : null}
          {(outdated || broken) ? (
            <div className="flex items-center gap-2">
              <span className="text-micro text-ink-muted">{reasonText(outdated ? 'outdated' : 'broken')}</span>
              <button
                type="button"
                className="shrink-0 text-micro text-ink-default underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(suggestedText(record)).then(() => setCopied(true), () => setCopied(false));
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
              <Button size="sm" className="h-7 gap-1 px-2 text-xs" disabled={busy || preview.state !== 'ready' || outdated || broken} onClick={() => void act('accept')}>
                <Check aria-hidden className="h-3 w-3" />
                Accept
              </Button>
              <Button size="sm" variant="secondary" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={() => void act('reject')}>
                <X aria-hidden className="h-3 w-3" />
                Reject
              </Button>
            </>
          ) : null}
          {own && !reviewer ? (
            <Button size="sm" variant="secondary" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={() => void act('withdraw')}>
              <X aria-hidden className="h-3 w-3" />
              Withdraw
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** In the top bar: the count of open suggestions, opening the panel of cards. */
export function SuggestionsButton({ docId, source }: { docId: string; source: SuggestionsSource }): ReactNode {
  const records = useRecords(source);
  const role = useDocRole(docId);
  const auth = useAuthState();
  useSyncExternalStore(subscribePanels, () => panelVersion, () => 0);
  const me = auth.status === 'signed-in' ? auth.user.id : null;
  const isOpen = openPanels.has(docId);
  const active = openPanels.get(docId) ?? null;
  const open = records.filter((record) => record.meta.status === 'open').sort((a, b) => b.meta.createdAt - a.meta.createdAt);
  const reviewed = records
    .filter((record) => record.meta.status !== 'open')
    .sort((a, b) => (b.meta.resolvedAt ?? b.meta.createdAt) - (a.meta.resolvedAt ?? a.meta.createdAt))
    .slice(0, REVIEWED_SHOWN);
  if (role === null) return null;
  return (
    <DropdownMenu open={isOpen} onOpenChange={(next) => (next ? openSuggestion(docId, null) : closePanel(docId))}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-collab-chrome=""
          {...{ [SUGGESTIONS_BUTTON_ATTR]: String(open.length) }}
          aria-label={open.length ? `Suggestions, ${open.length} open` : 'Suggestions'}
          title="Suggestions"
          className="relative flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
        >
          <GitPullRequestArrow aria-hidden className="h-3.5 w-3.5" />
          {open.length ? <span className="text-micro tabular-nums text-ink-muted">{open.length}</span> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0" {...{ [SUGGESTIONS_PANEL_ATTR]: '' }}>
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
          <span className="text-xs font-medium text-ink-default">Suggestions</span>
          {open.length ? <span className="text-micro text-ink-faint">{open.length} open</span> : null}
        </div>
        <div className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto p-2">
          {open.length === 0 && reviewed.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-xs text-ink-default">No suggestions</p>
              <p className="mt-1 text-micro text-ink-faint">
                {can(role, 'suggest') ? 'Switch to Suggest mode to propose changes. Your edits appear here for review.' : 'Suggested changes appear here for review.'}
              </p>
            </div>
          ) : null}
          {open.map((record) => (
            <SuggestionCard key={record.meta.id} docId={docId} record={record} me={me} role={role} active={record.meta.id === active} />
          ))}
          {reviewed.length ? <p className="mt-1 px-1 text-micro font-medium uppercase tracking-wide text-ink-faint">Reviewed</p> : null}
          {reviewed.map((record) => (
            <SuggestionCard key={record.meta.id} docId={docId} record={record} me={me} role={role} active={record.meta.id === active} />
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
