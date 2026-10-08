// The History view (A§14, T6.3): glyphdown's history page (d.$docId.history.tsx) rebuilt from moss's DS. History in
// the note's top bar turns the editor pane into the version list with its badges and the selected version, shown
// as Diff vs current or in a read-only, unbound MarkdownEditor; Restore asks through moss's ConfirmationDialog.
// With no versions it is moss's VersionHistoryEmptyState, where an editor saves a first named checkpoint. A failed
// fetch is said as an error, never shown as an empty history. The live editor stays mounted and bound underneath.
import { MarkdownEditor } from '@moss-desktop/renderer/editor/MarkdownEditor';
import { VersionHistoryEmptyState } from '@moss/shared/components/notes/VersionHistoryEmptyState';
import { Button } from '@moss/shared/components/ui/button';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { Input } from '@moss/shared/components/ui/input';
import { noteEntityAtom } from '@moss/shared/state/note-atoms';
import {
  HISTORY_BUTTON_ATTR, HISTORY_VIEW_ATTR, VERSION_CONTENT_ATTR, VERSION_ID_ATTR, VERSION_ROW_ATTR, VERSION_TITLE_ATTR, type HistoryViewState,
} from '@moss-multi/protocol/dom-contract';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { captureRestoreBase, type RestoreBase } from '@moss-multi/sync/restore-base';
import { useAtomValue } from 'jotai';
import { ArrowLeft, Clock, History, RotateCcw, Tag } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { useDocRole } from '../access.ts';
import { useAuthState } from '../auth.ts';
import { heldDocOf } from '../collab/doc-session.ts';
import { displayTitle } from '../collab/title-binding.ts';
import { versionPreviewNoteId } from '../media/web-asset-url.ts';
import { timeAgo } from '../surfaces/NotificationsBell.tsx';
import { diffStats, diffText } from './diff.ts';

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

async function call(url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; text: string }> {
  // A role that comes from a share link travels with every call, as the comment API's does.
  const share = new URLSearchParams(window.location.search).get('share');
  const headers: Record<string, string> = { accept: 'application/json', ...(share ? { 'x-moss-share': share } : {}) };
  const response = await fetch(url, body === undefined
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

/** The note's body as markdown, without its frontmatter: what the read-only editor renders. */
function bodyOf(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
  return match ? markdown.slice(match[0].length).replace(/^\r?\n/, '') : markdown;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const BADGE = 'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-micro';

function VersionBadge({ kind }: { kind: VersionKind }): ReactNode {
  if (kind === 'named') {
    return (
      <span className={`${BADGE} bg-surface-note-selected/70 text-accent-brand-pressed`}>
        <Tag aria-hidden className="h-2.5 w-2.5" />
        Named
      </span>
    );
  }
  if (kind === 'restore-point') return <span className={`${BADGE} bg-surface-badge text-accent-terracotta`}>Restore point</span>;
  return <span className={`${BADGE} bg-surface-badge text-ink-muted`}>Auto</span>;
}

/** In the top bar: History, for a signed-in person who can open the note. */
export function HistoryButton({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const auth = useAuthState();
  const isOpen = useHistoryOpen(docId);
  if (role === null || auth.status !== 'signed-in') return null;
  return (
    <button
      type="button"
      data-collab-chrome=""
      {...{ [HISTORY_BUTTON_ATTR]: '' }}
      aria-label="History"
      aria-pressed={isOpen}
      title="Version history"
      onClick={() => setHistoryOpen(docId, !isOpen)}
      className={`flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-surface-note-hover/40 focus-visible:outline-none ${isOpen ? 'text-ink-default' : 'text-ink-faint hover:text-ink-muted'}`}
    >
      <History aria-hidden className="h-3.5 w-3.5" />
    </button>
  );
}

/** Name a version: the empty state's first checkpoint and the list's later ones. */
function SaveVersion({ docId, onSaved, compact }: { docId: string; onSaved: (id: string) => void; compact?: boolean }): ReactNode {
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
    <form onSubmit={(event) => void submit(event)} className={compact ? 'flex flex-col gap-1.5' : 'flex w-full max-w-sm flex-col gap-2'}>
      <div className="flex gap-2">
        <Input
          aria-label="Version name"
          placeholder={compact ? 'Name this version' : 'Name your first checkpoint'}
          value={name}
          maxLength={NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          className={compact ? 'h-7 text-xs' : undefined}
        />
        <Button type="submit" size="sm" className={compact ? 'h-7 shrink-0 px-2 text-xs' : 'shrink-0'} disabled={busy || !name.trim()}>
          Save version
        </Button>
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
    <div>
      <p className="mb-2 text-xs text-ink-muted">
        {unchanged && !titleChanged ? (
          'This version matches the current note.'
        ) : (
          <>
            <span className="font-medium text-accent-brand-pressed">+{stats.added}</span>{' '}
            <span className="font-medium text-accent-terracotta">−{stats.removed}</span> characters since this version (green was added
            since, struck out was removed since)
          </>
        )}
      </p>
      <div className="rounded-lg border border-border-subtle bg-surface-raised-card px-5 py-4">
        <p {...{ [VERSION_TITLE_ATTR]: '' }} className="mb-3 break-words text-lg font-semibold text-ink-default">
          {titleChanged ? (
            <>
              <del className="bg-accent-terracotta/10 text-accent-terracotta">{title}</del>
              <ins className="bg-accent-brand/10 text-accent-brand-pressed no-underline">{currentTitle}</ins>
            </>
          ) : title}
        </p>
        <pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-default">
          {spans.map((span, i) =>
            span.kind === 'equal' ? (
              <span key={i}>{span.text}</span>
            ) : span.kind === 'insert' ? (
              <ins key={i} className="rounded-sm bg-accent-brand/10 text-accent-brand-pressed no-underline">{span.text}</ins>
            ) : (
              <del key={i} className="rounded-sm bg-accent-terracotta/10 text-accent-terracotta">{span.text}</del>
            ),
          )}
        </pre>
      </div>
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
  const [mode, setMode] = useState<'diff' | 'view'>('diff');
  const [texts, setTexts] = useState<Record<string, Loaded<VersionText>>>({});
  const [textRound, setTextRound] = useState(0);
  const [current, setCurrent] = useState<Loaded<string>>({ state: 'loading' });
  const [currentRound, setCurrentRound] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // The note as this tab held it when Restore was opened: the restore's base, so what others type after it is kept.
  const restoreBase = useRef<{ base: Omit<RestoreBase, 'age'>; at: number } | null>(null);

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

  // The current note, read again whenever the diff is asked for.
  useEffect(() => {
    if (mode !== 'diff' || !selected) return;
    let live = true;
    setCurrent({ state: 'loading' });
    call(`${docUrl(docId)}/content`).then(
      ({ ok, text, json }) => live && setCurrent(ok ? { state: 'ready', value: text } : { state: 'error', message: refusal(json, 'The current note could not be loaded.') }),
      () => live && setCurrent({ state: 'error', message: 'The current note could not be loaded. The server could not be reached.' }),
    );
    return () => {
      live = false;
    };
  }, [docId, mode, selected?.id, currentRound]);

  const choose = useCallback((id: string) => {
    setSelectedId(id);
    setRestoreError(null);
    setCurrentRound((r) => r + 1);
  }, []);

  const openRestore = () => {
    const held = heldDocOf(docId);
    restoreBase.current = held ? { base: captureRestoreBase(held.doc, held.payloads), at: performance.now() } : null;
    setConfirming(true);
  };

  const restore = async () => {
    if (!selected) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const seen = restoreBase.current;
      const base = seen ? { ...seen.base, age: Math.max(0, Math.round(performance.now() - seen.at)) } : undefined;
      const result = await call(`${docUrl(docId)}/versions/${encodeURIComponent(selected.id)}/restore`, { base });
      if (!result.ok) {
        setRestoreError(refusal(result.json, 'The version could not be restored.'));
        return;
      }
      setHistoryOpen(docId, false);
    } catch {
      setRestoreError('The server could not be reached. Try again.');
    } finally {
      setRestoring(false);
    }
  };

  const viewState: HistoryViewState = list.state === 'loading' ? 'loading' : list.state === 'error' ? 'error' : versions.length === 0 ? 'empty' : 'ready';
  const saved = (id: string) => {
    if (id) setSelectedId(id);
    setListRound((r) => r + 1);
  };

  return (
    <section
      {...{ [HISTORY_VIEW_ATTR]: viewState }}
      aria-label="Version history"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-canvas"
    >
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border-subtle px-3">
        <button
          type="button"
          onClick={() => setHistoryOpen(docId, false)}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-note-hover/40 hover:text-ink-default focus-visible:outline-none"
        >
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          Back to note
        </button>
        <span className="min-w-0 truncate text-xs font-medium text-ink-default">Version history</span>
      </div>

      {viewState === 'loading' ? (
        <p className="p-6 text-xs text-ink-faint">Loading versions…</p>
      ) : list.state === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p role="alert" className="text-sm text-ink-default">{list.message}</p>
          <Button size="sm" variant="secondary" onClick={() => setListRound((r) => r + 1)}>
            Try again
          </Button>
        </div>
      ) : viewState === 'empty' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-6">
          <VersionHistoryEmptyState
            className="h-auto w-full max-w-md"
            description={editor
              ? 'Versions are saved automatically as the note changes. Save your first checkpoint to mark this moment.'
              : 'Versions are saved automatically as the note changes.'}
          />
          {editor ? <SaveVersion docId={docId} onSaved={saved} /> : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex max-h-56 w-full shrink-0 flex-col border-b border-border-subtle bg-surface-panel md:max-h-none md:w-72 md:border-b-0 md:border-r">
            {editor ? (
              <div className="border-b border-border-subtle p-2.5">
                <SaveVersion docId={docId} onSaved={saved} compact />
              </div>
            ) : null}
            <ul aria-label="Versions" className="m-0 min-h-0 flex-1 list-none divide-y divide-border-subtle overflow-y-auto p-0">
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    {...{ [VERSION_ROW_ATTR]: v.kind, [VERSION_ID_ATTR]: v.id }}
                    aria-pressed={selected?.id === v.id}
                    onClick={() => choose(v.id)}
                    className={`block w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-surface-note-hover/40 focus-visible:outline-none ${selected?.id === v.id ? 'bg-surface-note-selected/70' : ''}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <VersionBadge kind={v.kind} />
                      <span className="ml-auto text-micro text-ink-faint">{timeAgo(v.createdAt)}</span>
                    </div>
                    {v.name ? <p className="mt-1 truncate text-sm font-medium text-ink-default">{v.name}</p> : null}
                    <p className="mt-0.5 text-micro text-ink-faint">
                      {new Date(v.createdAt).toLocaleString()} · {formatBytes(v.bytes)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <div className="min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <div className="mx-auto max-w-3xl px-6 py-6">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <h2 className="m-0 flex min-w-0 items-center gap-2 text-base font-semibold text-ink-default">
                    <Clock aria-hidden className="h-4 w-4 shrink-0 text-ink-muted" />
                    <span className="truncate">{selected.name ?? `Version from ${new Date(selected.createdAt).toLocaleString()}`}</span>
                  </h2>
                  <VersionBadge kind={selected.kind} />
                  <div className="ml-auto flex items-center gap-2">
                    <div className="flex overflow-hidden rounded-md border border-border-subtle text-xs">
                      {(['diff', 'view'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={mode === m}
                          onClick={() => {
                            setMode(m);
                            if (m === 'diff') setCurrentRound((r) => r + 1);
                          }}
                          className={`cursor-pointer px-2.5 py-1 transition-colors focus-visible:outline-none ${mode === m ? 'bg-surface-note-selected text-ink-default' : 'bg-surface-panel text-ink-muted hover:text-ink-default'}`}
                        >
                          {m === 'diff' ? 'Diff vs current' : 'View'}
                        </button>
                      ))}
                    </div>
                    {editor ? (
                      <Button size="sm" className="h-7 gap-1 px-2 text-xs" disabled={restoring} onClick={openRestore}>
                        <RotateCcw aria-hidden className="h-3 w-3" />
                        Restore
                      </Button>
                    ) : null}
                  </div>
                </div>
                {restoreError ? <p role="alert" className="mb-3 text-xs text-accent-terracotta">{restoreError}</p> : null}

                {!selectedText || selectedText.state === 'loading' || (mode === 'diff' && current.state === 'loading') ? (
                  <p className="text-xs text-ink-faint">Loading version…</p>
                ) : selectedText.state === 'error' || (mode === 'diff' && current.state === 'error') ? (
                  <div className="flex items-center gap-2">
                    <p role="alert" className="text-xs text-accent-terracotta">
                      {selectedText.state === 'error' ? selectedText.message : current.state === 'error' ? current.message : ''}
                    </p>
                    <button
                      type="button"
                      className="text-xs text-ink-default underline"
                      onClick={() => {
                        setTextRound((r) => r + 1);
                        setCurrentRound((r) => r + 1);
                      }}
                    >
                      Try again
                    </button>
                  </div>
                ) : mode === 'view' ? (
                  <div {...{ [VERSION_CONTENT_ATTR]: 'view' }}>
                    <VersionReader docId={docId} id={selected.id} text={selectedText.value} />
                  </div>
                ) : (
                  <div {...{ [VERSION_CONTENT_ATTR]: 'diff' }}>
                    <DiffView
                      title={displayTitle(selectedText.value.title)}
                      currentTitle={note?.title ?? displayTitle(selectedText.value.title)}
                      oldText={selectedText.value.markdown}
                      newText={current.state === 'ready' ? current.value : ''}
                    />
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <ConfirmationDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Restore this version?"
        description="The note will be changed back to this version. Restoring is itself an edit: the note as it is now is kept as a restore point, and anything others type from now on is kept where they typed it."
        confirmLabel="Restore"
        onConfirm={() => void restore()}
      />
    </section>
  );
}
