// The History view (A§14, T6.3, T9.42): a quiet recovery view. More actions → Version history turns the editor pane
// into a 280 px version list (Moss's compact note rows; runs of automatic saves fold under their newest) beside the
// selected version, shown as the note in a read-only, unbound MarkdownEditor. Compare with current is off until asked
// for. Naming the note as it is now is a small disclosure. Restore waits for the version's preview and asks through
// moss's ConfirmationDialog by name, Cancel focused. A failed fetch is said as an error, never shown as an empty
// history. Narrower than md the version replaces the list, with Back to versions. The live editor stays mounted.
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { MarkdownEditor } from '@moss-desktop/renderer/editor/MarkdownEditor';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { Input } from '@moss/shared/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { noteEntityAtom } from '@moss/shared/state/note-atoms';
import {
  HISTORY_VIEW_ATTR, RESTORE_NOTICE_ATTR, VERSION_CONTENT_ATTR, VERSION_ID_ATTR, VERSION_ROW_ATTR, VERSION_TITLE_ATTR,
  type HistoryViewState,
} from '@moss-multi/protocol/dom-contract';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { captureRestoreBase, type RestoreBase } from '@moss-multi/sync/restore-base';
import { useAtomValue } from 'jotai';
import { ArrowLeft, ChevronRight, Info, Loader2, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useDocRole } from '../access.ts';
import { useAuthState } from '../auth.ts';
import { sessionFetch, useSessionEnded } from '../session-fetch.ts';
import { heldDocOf, waitDocsAcked } from '../collab/doc-session.ts';
import { showActionFeedback } from '../collab/feedback.ts';
import { beginOwnRestore, dismissRestoreNotice, useRestoreNotice } from '../collab/restore-notice.ts';
import { clearUndoOf } from '../collab/undo.ts';
import { displayTitle } from '../collab/title-binding.ts';
import { versionPreviewNoteId } from '../media/web-asset-url.ts';
import { diffStats, diffText } from './diff.ts';
import { Banner } from '../../../../../packages/ui/src/Banner.tsx';
import { NOTICE_ACTION, NOTICE_DISMISS } from '../notice-stack.ts';

type VersionKind = 'auto' | 'named' | 'restore-point';

interface VersionMeta {
  id: string;
  kind: VersionKind;
  name: string | null;
  createdAt: number;
  title: string;
  bytes: number;
}

/** One version as GET /versions/:vid returns it: the whole title and the markdown. */
interface VersionText {
  title: string;
  markdown: string;
}

const NAME_MAX = 80;
/** How long a save or a diff waits for this tab's own edits to be acked, as the trash guard does. */
const ACK_WAIT_MS = 5_000;
const UNSYNCED = 'Your latest edits are not synced yet.';

// Which notes have History open.
const open = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setHistoryOpen(docId: string, next: boolean): void {
  if (next === open.has(docId)) return;
  if (next) open.add(docId);
  else open.delete(docId);
  changed();
}

export function useHistoryOpen(docId: string | null): boolean {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return docId !== null && open.has(docId);
}

// The version History selects when it next shows the note: a restore notice opens it on the restore point.
const wanted = new Map<string, string>();

export function openHistoryAt(docId: string, versionId: string): void {
  wanted.set(docId, versionId);
  if (open.has(docId)) changed();
  else setHistoryOpen(docId, true);
}

function useWantedVersion(docId: string): string | null {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return wanted.get(docId) ?? null;
}

async function call(url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; text: string }> {
  // A role that comes from a share link travels with every call, as the comment API's does.
  const share = new URLSearchParams(window.location.search).get('share');
  const headers: Record<string, string> = { accept: 'application/json', ...(share ? { 'x-moss-share': share } : {}) };
  const response = await sessionFetch(url, body === undefined
    ? { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers }
    : { method: 'POST', credentials: 'same-origin', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: the markdown export, or a broken answer.
  }
  return { ok: response.ok, status: response.status, json, text };
}

const docUrl = (docId: string) => `/api/docs/${encodeURIComponent(docId)}`;

/** The server's sentence for a refusal, else ours. */
const refusal = (json: Record<string, unknown>, fallback: string): string =>
  typeof json.message === 'string' ? json.message : json.error === 'rate-limited' ? 'Too many requests. Try again in a minute.' : fallback;

type Restored = { ok: true; point: string | null } | { ok: false; message: string };

/**
 * Restores `versionId` over `base`. Once it lands, this tab's undo stacks for the note are cleared: their steps
 * describe what the restore replaced. The DocDO's event for it is this tab's own, so it names no one here.
 */
async function postRestore(docId: string, versionId: string, base: RestoreBase | undefined): Promise<Restored> {
  const finish = beginOwnRestore(docId);
  let point: string | null | undefined;
  try {
    const result = await call(`${docUrl(docId)}/versions/${encodeURIComponent(versionId)}/restore`, { base });
    if (!result.ok) return { ok: false, message: refusal(result.json, 'The version could not be restored.') };
    point = typeof result.json.restorePoint === 'string' ? result.json.restorePoint : null;
    const held = heldDocOf(docId);
    if (held) clearUndoOf(held.doc);
    return { ok: true, point };
  } catch {
    return { ok: false, message: 'The server could not be reached. Try again.' };
  } finally {
    finish(point);
  }
}

/** Moss's feedback pill confirms the restore; its Undo restores the restore point over the note as it is at the click. */
function confirmRestore(docId: string, point: string | null): void {
  let undone = false;
  const undo = async () => {
    if (undone) return;
    undone = true;
    const held = heldDocOf(docId);
    const base = held ? { ...captureRestoreBase(held.doc, held.payloads), age: 0 } : undefined;
    const result = point ? await postRestore(docId, point, base) : { ok: false as const, message: 'The version could not be restored.' };
    if (!result.ok) showActionFeedback(docId, { type: 'error', message: result.message });
  };
  showActionFeedback(docId, { type: 'success', message: 'Restored version', ...(point ? { action: { label: 'Undo', onClick: () => void undo() } } : {}) });
}

/**
 * The note's body as markdown, without its frontmatter: what the read-only editor renders. A leading section is
 * frontmatter only when it parses as a properties mapping, as the import reads it; a note with no properties can
 * start with a rule.
 */
function bodyOf(markdown: string): string {
  const parts = splitFrontmatter(markdown);
  return parts.hasFrontmatter && !parts.error ? parts.body.replace(/^\r?\n/, '') : markdown;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** A version's time as a list row says it: "Today, 2:46 PM", "Yesterday, …", "Nov 13, …", with the year once it differs. */
function whenOf(at: number, now = new Date()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, now)) return `Today, ${time}`;
  if (sameDay(date, yesterday)) return `Yesterday, ${time}`;
  const day = date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${day}, ${time}`;
}

/** What a row names a version by: its name, else what it is. */
const labelOf = (v: VersionMeta): string => v.name ?? (v.kind === 'restore-point' ? 'Before a restore' : whenOf(v.createdAt));

/** The version's details, said once in its tooltip rather than as chips on every row. */
const detailsOf = (v: VersionMeta): string =>
  `${v.kind === 'named' ? 'Named version' : v.kind === 'restore-point' ? 'Restore point, kept before a restore' : 'Saved automatically'} · ${new Date(v.createdAt).toLocaleString()} · ${formatBytes(v.bytes)}`;

type ListEntry = { type: 'row'; v: VersionMeta } | { type: 'fold'; key: string; count: number; open: boolean };

/**
 * The list's entries: every run of automatic saves shows its newest, and the rest fold under one quiet line. A folded
 * version that is selected still shows. Nothing is dropped from the history.
 */
function listEntries(versions: VersionMeta[], unfolded: ReadonlySet<string>, selectedId: string | null): ListEntry[] {
  const out: ListEntry[] = [];
  for (let i = 0; i < versions.length;) {
    const head = versions[i]!;
    if (head.kind !== 'auto') {
      out.push({ type: 'row', v: head });
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < versions.length && versions[end]!.kind === 'auto') end += 1;
    const rest = versions.slice(i + 1, end);
    out.push({ type: 'row', v: head });
    if (rest.length > 0) {
      const open = unfolded.has(head.id);
      for (const v of rest) if (open || v.id === selectedId) out.push({ type: 'row', v });
      out.push({ type: 'fold', key: head.id, count: rest.length, open });
    }
    i = end;
  }
  return out;
}

/** Moss's quiet text action (Settings' Add, 12 px neutral, 28 px tall). */
const TEXT_ACTION = 'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs text-ink-muted transition-colors hover:bg-surface-note-hover/40 hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15';
/** Moss's 28 px icon target with its faint ink. */
const ICON_ACTION = 'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15';
/** A neutral bordered action, Moss's dialog Cancel recipe: Restore and Save never shout in brand green. */
const NEUTRAL_ACTION = 'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 text-xs font-medium text-ink-default transition hover:bg-surface-note-hover/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent';

function Busy({ children }: { children: ReactNode }): ReactNode {
  return <><Loader2 aria-hidden className="h-3 w-3 animate-spin" />{children}</>;
}

function Tip({ tip, children }: { tip: string; children: ReactNode }): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Whether More actions offers Version history: to a signed-in person who can open the note (T9.30). */
export function useCanOpenHistory(docId: string): boolean {
  const role = useDocRole(docId);
  const auth = useAuthState();
  return role !== null && auth.status === 'signed-in';
}

/**
 * Someone else's restore of the open note, as a card in the pane's bottom region (T9.41) until dismissed. Whoever can
 * open History can open it on the restore point, which holds the note as it was before.
 */
export function RestoreNoticeBand({ docId }: { docId: string }): ReactNode {
  const notice = useRestoreNotice(docId);
  const role = useDocRole(docId);
  const auth = useAuthState();
  if (!notice) return null;
  const canOpen = role !== null && auth.status === 'signed-in' && notice.point !== null;
  return (
    <Banner
      {...{ [RESTORE_NOTICE_ATTR]: '' }}
      icon={<RotateCcw aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />}
      action={<>
        {canOpen ? (
          <button type="button" className={NOTICE_ACTION} onClick={() => openHistoryAt(docId, notice.point!)}>
            See the note before the restore
          </button>
        ) : null}
        <button type="button" className={NOTICE_DISMISS} onClick={() => dismissRestoreNotice(docId)}>
          Dismiss
        </button>
      </>}
    >
      {notice.by} restored an earlier version of this note.
    </Banner>
  );
}

/** The disclosure that saves a named version of the note as it is now; it never renames a past version. */
function SaveVersion({ docId, onSaved, onCancel }: { docId: string; onSaved: (id: string) => void; onCancel: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The version is what the server holds, so this tab's own typing reaches it first; unsynced, nothing is sent.
      if (!(await waitDocsAcked([docId], ACK_WAIT_MS))) {
        setError(`${UNSYNCED} The version was not saved; try again in a moment.`);
        return;
      }
      const result = await call(`${docUrl(docId)}/versions`, { name: trimmed });
      if (!result.ok) {
        setError(refusal(result.json, 'The version could not be saved.'));
        return;
      }
      setName('');
      onSaved(String((result.json.version as { id?: unknown } | undefined)?.id ?? ''));
    } catch {
      setError('The server could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1.5 px-2 pb-2">
      <Input
        aria-label="Version name"
        placeholder="Name the note as it is now"
        value={name}
        maxLength={NAME_MAX}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || busy) return;
          event.stopPropagation();
          onCancel();
        }}
        className="h-7 text-xs"
      />
      <div className="flex items-center justify-end gap-1">
        <button type="button" className={TEXT_ACTION} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={NEUTRAL_ACTION} disabled={busy || !name.trim()}>
          {busy ? <Busy>Saving…</Busy> : 'Save version'}
        </button>
      </div>
      {error ? <p role="alert" className="text-micro text-accent-terracotta">{error}</p> : null}
    </form>
  );
}

function DiffView({ title, currentTitle, oldText, newText }: { title: string; currentTitle: string; oldText: string; newText: string }): ReactNode {
  const spans = useMemo(() => diffText(oldText, newText), [oldText, newText]);
  const stats = useMemo(() => diffStats(spans), [spans]);
  const unchanged = spans.length === 0 || (spans.length === 1 && spans[0]?.kind === 'equal');
  const titleChanged = currentTitle !== title;
  return (
    <div className="mx-auto w-full max-w-canvas-prose">
      <p className="mb-4 text-xs text-ink-muted">
        {unchanged && !titleChanged
          ? 'This version matches the current note.'
          : `From this version to the current note: ${stats.added} characters added since this version (shaded), ${stats.removed} removed (struck through).`}
      </p>
      <p {...{ [VERSION_TITLE_ATTR]: '' }} className="mb-1 break-words text-h1 font-semibold tracking-title text-ink-default">
        {titleChanged ? (
          <>
            <del className="text-ink-faint">{title}</del>{' '}
            <ins className="rounded-sm bg-accent-brand/10 no-underline">{currentTitle}</ins>
          </>
        ) : title}
      </p>
      <pre className="m-0 whitespace-pre-wrap break-words font-sans text-base leading-relaxed text-ink-default">
        {spans.map((span, i) =>
          span.kind === 'equal' ? (
            <span key={i}>{span.text}</span>
          ) : span.kind === 'insert' ? (
            <ins key={i} className="rounded-sm bg-accent-brand/10 no-underline">{span.text}</ins>
          ) : (
            <del key={i} className="text-ink-faint">{span.text}</del>
          ),
        )}
      </pre>
    </div>
  );
}

/** The version in an unbound, read-only editor under its own id, so it never touches the live note; its media are the note's. */
function VersionReader({ docId, id, text }: { docId: string; id: string; text: VersionText }): ReactNode {
  const body = useMemo(() => bodyOf(text.markdown), [text.markdown]);
  return (
    <div className="mx-auto w-full max-w-canvas-prose">
      <p {...{ [VERSION_TITLE_ATTR]: '' }} className="mb-1 break-words text-h1 font-semibold tracking-title text-ink-default">{displayTitle(text.title)}</p>
      <MarkdownEditor key={id} noteId={versionPreviewNoteId(docId, id)} value={body} readOnly onChange={() => undefined} placeholder="" />
    </div>
  );
}

type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };

/** The pane's History view. */
export function HistoryView({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const editor = roleAtLeast(role, 'editor');
  const note = useAtomValue(noteEntityAtom(docId)) as { title?: string } | null;
  const [list, setList] = useState<Loaded<VersionMeta[]>>({ state: 'loading' });
  const [listRound, setListRound] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [naming, setNaming] = useState(false);
  const [narrowList, setNarrowList] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const [texts, setTexts] = useState<Record<string, Loaded<VersionText>>>({});
  const [textRound, setTextRound] = useState(0);
  const [current, setCurrent] = useState<Loaded<string>>({ state: 'loading' });
  const [currentRound, setCurrentRound] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<VersionMeta | null>(null);
  // The note as this tab held it when Restore was opened: the restore's base, so what others type after it is kept.
  const restoreBase = useRef<{ base: Omit<RestoreBase, 'age'>; at: number } | null>(null);
  // A session that ended under History closes it: the note's banner says how to sign in again.
  const ended = useSessionEnded();
  useEffect(() => {
    if (ended) setHistoryOpen(docId, false);
  }, [ended, docId]);

  useEffect(() => {
    let live = true;
    setList((was) => (was.state === 'ready' ? was : { state: 'loading' }));
    call(`${docUrl(docId)}/versions`).then(
      ({ ok, json }) => {
        if (!live) return;
        const versions = json.versions;
        if (ok && Array.isArray(versions)) setList({ state: 'ready', value: versions as VersionMeta[] });
        else setList({ state: 'error', message: `Version history could not be loaded. ${refusal(json, 'Try again.')}` });
      },
      () => live && setList({ state: 'error', message: 'Version history could not be loaded. The server could not be reached.' }),
    );
    return () => {
      live = false;
    };
  }, [docId, listRound]);

  // Opened on a given version (a restore notice's restore point): it is selected once listed.
  const want = useWantedVersion(docId);
  useEffect(() => {
    if (!want) return;
    setSelectedId(want);
    setRestoreError(null);
    if (list.state === 'ready' && !list.value.some((v) => v.id === want)) setListRound((r) => r + 1);
    wanted.delete(docId);
  }, [docId, want]);

  const versions = list.state === 'ready' ? list.value : [];
  const selected = versions.find((v) => v.id === selectedId) ?? versions[0] ?? null;
  const selectedText = selected ? texts[selected.id] : undefined;

  // A version's answer is kept even after the selection moves on, so going back to it never finds it stuck loading.
  const shownDoc = useRef('');
  useEffect(() => {
    shownDoc.current = docId;
    return () => {
      shownDoc.current = '';
    };
  }, [docId]);
  useEffect(() => {
    if (!selected) return;
    const id = selected.id;
    const had = texts[id];
    if (had && had.state !== 'error') return;
    const live = () => shownDoc.current === docId;
    setTexts((all) => ({ ...all, [id]: { state: 'loading' } }));
    call(`${docUrl(docId)}/versions/${encodeURIComponent(id)}`).then(
      ({ ok, json }) => {
        if (!live()) return;
        const shown = json.version as { title?: unknown; markdown?: unknown } | undefined;
        setTexts((all) => ({
          ...all,
          [id]: ok && typeof shown?.markdown === 'string'
            ? { state: 'ready', value: { title: typeof shown.title === 'string' ? shown.title : '', markdown: shown.markdown } }
            : { state: 'error', message: refusal(json, 'This version could not be loaded.') },
        }));
      },
      () => live() && setTexts((all) => ({ ...all, [id]: { state: 'error', message: 'This version could not be loaded. The server could not be reached.' } })),
    );
    // `texts` is read only to skip a version already loaded, so it is not a dependency.
  }, [docId, selected?.id, textRound]);

  // The current note, read again whenever the diff is asked for, once this tab's own typing has reached the server.
  useEffect(() => {
    if (!compare || !selected) return;
    let live = true;
    setCurrent({ state: 'loading' });
    void waitDocsAcked([docId], ACK_WAIT_MS).then((acked) => {
      if (!live) return;
      if (!acked) {
        setCurrent({ state: 'error', message: `${UNSYNCED} The note can be compared once they are.` });
        return;
      }
      call(`${docUrl(docId)}/content`).then(
        ({ ok, text, json }) => live && setCurrent(ok ? { state: 'ready', value: text } : { state: 'error', message: refusal(json, 'The current note could not be loaded.') }),
        () => live && setCurrent({ state: 'error', message: 'The current note could not be loaded. The server could not be reached.' }),
      );
    });
    return () => {
      live = false;
    };
  }, [docId, compare, selected?.id, currentRound]);

  const choose = useCallback((id: string) => {
    setSelectedId(id);
    setRestoreError(null);
    setCurrentRound((r) => r + 1);
    setNarrowList(false);
  }, []);

  const canRestore = editor && selected !== null && selectedText?.state === 'ready';
  const openRestore = () => {
    if (!canRestore || !selected) return;
    const held = heldDocOf(docId);
    restoreBase.current = held ? { base: captureRestoreBase(held.doc, held.payloads), at: performance.now() } : null;
    setConfirmFor(selected);
    setConfirming(true);
  };

  const restore = async () => {
    const target = confirmFor;
    if (!target) return;
    setRestoring(true);
    setRestoreError(null);
    const seen = restoreBase.current;
    const base = seen ? { ...seen.base, age: Math.max(0, Math.round(performance.now() - seen.at)) } : undefined;
    const result = await postRestore(docId, target.id, base);
    setRestoring(false);
    if (!result.ok) {
      setRestoreError(result.message);
      return;
    }
    setHistoryOpen(docId, false);
    confirmRestore(docId, result.point);
  };

  const viewState: HistoryViewState = list.state === 'loading' ? 'loading' : list.state === 'error' ? 'error' : versions.length === 0 ? 'empty' : 'ready';
  const saved = (id: string) => {
    if (id) setSelectedId(id);
    setNaming(false);
    setNarrowList(false);
    setListRound((r) => r + 1);
  };
  const entries = useMemo(() => listEntries(versions, unfolded, selected?.id ?? null), [versions, unfolded, selected?.id]);
  const fold = (key: string) => setUnfolded((was) => {
    const next = new Set(was);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  // Escape leaves History, as Back to note does, unless a field, a menu or the confirmation has it.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || confirming) return;
    const target = event.target as Element;
    if (target.closest('input, textarea, [role="dialog"], [role="alertdialog"], [role="menu"]')) return;
    setHistoryOpen(docId, false);
  };

  // Narrower than md the selected version replaces the list; the list shows while there is no version to read.
  const listFirst = narrowList || viewState !== 'ready';
  const when = selected ? whenOf(selected.createdAt) : '';

  return (
    <TooltipProvider>
      <section
        {...{ [HISTORY_VIEW_ATTR]: viewState }}
        aria-label="Version history"
        onKeyDown={onKeyDown}
        className="flex min-h-0 min-w-0 flex-1 flex-row bg-surface-canvas"
      >
        <aside className={`${listFirst ? 'flex' : 'hidden md:flex'} min-h-0 w-full shrink-0 flex-col bg-surface-panel md:w-[280px] md:border-r md:border-border-subtle`}>
          <div className="flex h-10 shrink-0 items-center gap-1 px-2">
            <button type="button" className={TEXT_ACTION} onClick={() => setHistoryOpen(docId, false)}>
              <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
              Back to note
            </button>
            {editor && (viewState === 'ready' || viewState === 'empty') ? (
              <Tip tip="Save a named version of the note as it is now">
                <button
                  type="button"
                  aria-label="Save named version"
                  aria-expanded={naming}
                  className={`${ICON_ACTION} ml-auto ${naming ? 'bg-surface-note-hover/40 text-ink-muted' : ''}`}
                  onClick={() => setNaming((was) => !was)}
                >
                  <Plus aria-hidden className="h-3.5 w-3.5" />
                </button>
              </Tip>
            ) : null}
          </div>
          {naming && editor && (viewState === 'ready' || viewState === 'empty') ? (
            <SaveVersion docId={docId} onSaved={saved} onCancel={() => setNaming(false)} />
          ) : null}
          <p className="px-4 pb-1 pt-1 text-micro text-ink-faint">Version history</p>
          {viewState === 'loading' ? (
            <p className="px-4 py-8 text-center text-caption text-ink-faint">Loading versions…</p>
          ) : list.state === 'error' ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <p role="alert" className="text-caption text-ink-muted">{list.message}</p>
              <button type="button" className={TEXT_ACTION} onClick={() => setListRound((r) => r + 1)}>
                Try again
              </button>
            </div>
          ) : viewState === 'empty' ? (
            <div className="flex flex-col gap-1 px-4 py-8 text-center">
              <p className="text-caption text-ink-muted">No versions yet</p>
              <p className="text-micro text-ink-faint md:hidden">Versions are saved automatically as the note changes.</p>
            </div>
          ) : (
            <ul aria-label="Versions" className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto px-2 pb-4 pt-0">
              {entries.map((entry) =>
                entry.type === 'fold' ? (
                  <li key={`fold-${entry.key}`}>
                    <button
                      type="button"
                      aria-expanded={entry.open}
                      onClick={() => fold(entry.key)}
                      className="flex w-full cursor-pointer items-center gap-1 rounded-md px-sidebar-row-x py-1 text-left text-micro text-ink-faint transition-colors hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                    >
                      <ChevronRight aria-hidden className={`h-3 w-3 transition-transform ${entry.open ? 'rotate-90' : ''}`} />
                      {entry.open ? 'Hide earlier automatic saves' : `${entry.count} earlier automatic ${entry.count === 1 ? 'save' : 'saves'}`}
                    </button>
                  </li>
                ) : (
                  <li key={entry.v.id}>
                    <button
                      type="button"
                      {...{ [VERSION_ROW_ATTR]: entry.v.kind, [VERSION_ID_ATTR]: entry.v.id }}
                      aria-pressed={selected?.id === entry.v.id}
                      onClick={() => choose(entry.v.id)}
                      className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-sidebar-row-x py-sidebar-row-y text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 ${selected?.id === entry.v.id ? 'bg-surface-note-selected/70 opacity-100' : 'opacity-80 hover:bg-surface-note-hover hover:opacity-100'}`}
                    >
                      <span className="truncate text-caption font-book text-ink-default">{labelOf(entry.v)}</span>
                      {entry.v.kind === 'auto' ? null : <span className="text-micro font-light text-ink-muted/70">{whenOf(entry.v.createdAt)}</span>}
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </aside>

        <div className={`${listFirst ? 'hidden md:flex' : 'flex'} min-h-0 min-w-0 flex-1 flex-col`}>
          {selected ? (
            <>
              <div className="flex h-10 shrink-0 items-center gap-1 px-3">
                <button type="button" className={`${TEXT_ACTION} md:hidden`} onClick={() => setNarrowList(true)}>
                  <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
                  Back to versions
                </button>
                <p className="hidden min-w-0 truncate px-1 text-xs text-ink-muted sm:block">
                  {selected.name ? `${selected.name} · ${when}` : selected.kind === 'restore-point' ? `Before a restore · ${when}` : when} · Read only
                </p>
                <Tip tip={detailsOf(selected)}>
                  <button type="button" aria-label="Version details" className={ICON_ACTION}>
                    <Info aria-hidden className="h-3.5 w-3.5" />
                  </button>
                </Tip>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    aria-label="Compare with current"
                    aria-pressed={compare}
                    onClick={() => {
                      setCompare((was) => !was);
                      setCurrentRound((r) => r + 1);
                    }}
                    className={`${TEXT_ACTION} ${compare ? 'bg-surface-note-selected/70 text-ink-default' : ''}`}
                  >
                    <span className="lg:hidden">Compare</span>
                    <span className="hidden lg:inline">Compare with current</span>
                  </button>
                  {editor ? (
                    <button type="button" className={NEUTRAL_ACTION} disabled={!canRestore || restoring} onClick={openRestore}>
                      {restoring ? <Busy>Restoring…</Busy> : <><RotateCcw aria-hidden className="h-3 w-3" />Restore</>}
                    </button>
                  ) : null}
                </div>
              </div>
              {restoreError ? <p role="alert" className="px-4 pb-2 text-xs text-accent-terracotta">{restoreError}</p> : null}

              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-canvas-blocks px-canvas-gutter pb-24 pt-canvas-body-top">
                  {!selectedText || selectedText.state === 'loading' || (compare && current.state === 'loading') ? (
                    <p className="mx-auto max-w-canvas-prose text-sm text-ink-faint">Loading version…</p>
                  ) : selectedText.state === 'error' || (compare && current.state === 'error') ? (
                    <div className="mx-auto flex max-w-canvas-prose flex-wrap items-center gap-2">
                      <p role="alert" className="text-sm text-ink-muted">
                        {selectedText.state === 'error' ? selectedText.message : current.state === 'error' ? current.message : ''}
                      </p>
                      <button
                        type="button"
                        className={TEXT_ACTION}
                        onClick={() => {
                          setTextRound((r) => r + 1);
                          setCurrentRound((r) => r + 1);
                        }}
                      >
                        Try again
                      </button>
                    </div>
                  ) : compare ? (
                    <div {...{ [VERSION_CONTENT_ATTR]: 'diff' }}>
                      <DiffView
                        title={displayTitle(selectedText.value.title)}
                        currentTitle={note?.title ?? displayTitle(selectedText.value.title)}
                        oldText={selectedText.value.markdown}
                        newText={current.state === 'ready' ? current.value : ''}
                      />
                    </div>
                  ) : (
                    <div {...{ [VERSION_CONTENT_ATTR]: 'view' }}>
                      <VersionReader docId={docId} id={selected.id} text={selectedText.value} />
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : viewState === 'empty' ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="max-w-sm text-center text-sm text-ink-muted">
                Versions are saved automatically as the note changes.
              </p>
            </div>
          ) : null}
        </div>

        <ConfirmationDialog
          open={confirming}
          onOpenChange={setConfirming}
          cancelAutoFocus
          title={`Restore “${confirmFor ? labelOf(confirmFor) : ''}”?`}
          description={`The note goes back to this version from ${confirmFor ? whenOf(confirmFor.createdAt) : ''} for everyone who can open it. The note as it is now is kept in History first, and anything others type from now on is kept where they typed it.`}
          confirmLabel="Restore"
          onConfirm={() => void restore()}
        />
      </section>
    </TooltipProvider>
  );
}
