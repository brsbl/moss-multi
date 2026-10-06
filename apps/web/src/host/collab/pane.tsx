// The one pane hook (A§2.2): CanvasAreaContent calls useMossMultiPane(note) once and reads from it everything a bound
// pane needs: the binding plugin MarkdownEditor mounts in place of its history, the first-sync gate (A§10.3), the
// readiness attributes (A§19), the title and Properties bindings (A§10.4), the top-bar collab slot and the terminal
// reason. A note opened from Trash binds nothing: moss shows it read-only from the owner's one read path for trashed
// notes (A§8), and its restore turns the view into a fresh binding. A note trashed while open stays bound and goes
// terminal in place.
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { Provider } from '@lexical/yjs';
import { CollaborationPlugin } from '@moss-multi/lexical-react/LexicalCollaborationPlugin';
import {
  BODY_BINDING_ATTR, DOC_ID_ATTR, DOC_STATE_ATTR, EDIT_MODE_ATTR, EDITOR_GENERATION_ATTR, EDITOR_PANE_ATTR, SUGGEST_REFUSED_ATTR,
  SUGGEST_SENT_ATTR, SYNC_UNACKED_ATTR, TERMINAL_REASON_ATTR, ROLE_ATTR, type BindingState, type DocState, type EditMode,
} from '@moss-multi/protocol/dom-contract';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import type { BodyUndo } from '@moss-multi/sync/payload-docs';
import { syncNoteEntityAtom } from '@moss/shared/state/atoms';
import { useStore } from 'jotai';
import { $createParagraphNode, $getRoot, $setSelection, type EditorState, type LexicalEditor } from 'lexical';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Doc, UndoManager } from 'yjs';
import { can, type Role } from '@moss-multi/protocol/roles';
import { knownRole, useDocRole } from '../access.ts';
import { TopBarCollab } from '../slots.tsx';
import { getBridge, WORKSPACE } from '../bridge/index.ts';
import {
  aliasProvider, docOwner, openDocSession, subscribeDocOwners, waitDocsAcked, type DocSession, type SessionState,
} from './doc-session.ts';
import { auth } from '../auth.ts';
import { captureCaret, type CaretMark } from './suggest/caret.ts';
import { modeFor, offerUnsaved, showMode, subscribeModes } from './suggest/mode.ts';
import { ReviewMount, SuggestMount } from './suggest/mounts.ts';
import { SuggestModeChip, SuggestUnsavedBand } from './suggest/SuggestChrome.tsx';
import { SuggestPlugin, type SuggestPane } from './suggest/SuggestPlugin.tsx';
import { bindFrontmatter } from './frontmatter-binding.ts';
import { bindCommentAtoms } from '../comments/atoms.ts';
import { setAckWaiter } from '../comments/api.ts';
import { setMyPrincipalId } from '../comments/people.ts';
import { displayTitle, TitleField } from './title-binding.ts';
import { localIdentity, startPresence } from './presence.ts';
import { cursorController } from './cursors.ts';
import { subscribeTerminal, terminalOf, useTerminal } from './terminal.ts';
import { trackUndoFocus } from './undo.ts';
import { ConnectionNotice } from './ConnectionNotice.tsx';

interface PaneState {
  docState: DocState;
  bodyState: BindingState;
  bodyVisible: boolean;
  resetting: boolean;
  revision: number;
  /** The body holds any text; moss reads its markdown string for this, which a bound note never fills. */
  hasText: boolean;
  /** Edit binds B, Suggest the fork F, Review the composite C (docs/design/suggestions.md §5). */
  mode: EditMode;
  /** Suggest mode's frames sent and refused, published on the pane. */
  suggestSent: number;
  suggestRefused: number;
}

/** +1 for every Lexical editor this tab creates (A§19 `data-editor-generation`, the remount detector). */
let generations = 0;
const generationOf = new WeakMap<LexicalEditor, number>();
function generation(editor: LexicalEditor): number {
  let value = generationOf.get(editor);
  if (value === undefined) {
    value = ++generations;
    generationOf.set(editor, value);
  }
  return value;
}

/** The doc's fields beside its body, bound at first sync (A§10.4): the title and Properties. One per pane. */
class DocFields {
  readonly title: TitleField;
  #frontmatter: { doc: Doc; stop: () => void } | null = null;

  constructor(private readonly store: ReturnType<typeof useStore>) {
    // Every title change names the note everywhere moss shows it: sidebar, breadcrumb, tabs.
    this.title = new TitleField((docId, text) => store.set(syncNoteEntityAtom, { noteId: docId, updates: { title: displayTitle(text) } }));
  }

  bind(docId: string, doc: Doc, canWrite: () => boolean): void {
    this.title.bind(docId, doc);
    if (this.#frontmatter?.doc === doc) return;
    this.#frontmatter?.stop();
    const stop = bindFrontmatter(this.store, docId, doc, canWrite);
    setMyPrincipalId(localIdentity().awarenessData.user?.principalId ?? null);
    setAckWaiter(waitDocsAcked);
    const stopComments = bindCommentAtoms(this.store, docId, doc);
    const updated = () => this.store.set(syncNoteEntityAtom, { noteId: docId, updates: { updatedAt: Math.floor(Date.now() / 1000) } });
    doc.on('update', updated);
    this.#frontmatter = { doc, stop: () => { stop(); stopComments(); doc.off('update', updated); } };
  }

  unbind(doc: Doc | null): void {
    if (!doc) return;
    this.title.unbind(doc);
    if (this.#frontmatter?.doc !== doc) return;
    this.#frontmatter.stop();
    this.#frontmatter = null;
  }
}

/**
 * One pane's binding of one doc: the session the plugin opened, the editor it binds, and the state the pane renders.
 * `data-sync-unacked` is written here, in the tick of the write it reports, not through a render.
 */
/** Steps of a closed record leave the undo stacks (§5): undoing them would rewrite text no suggestion holds now. */
function dropUndo(editor: LexicalEditor | null, clients: number[]): void {
  const stack = editor && (editor as unknown as Record<symbol, BodyUndo | undefined>)[Symbol.for('@lexical/yjs/UndoManager')];
  if (!stack) return;
  const touches = (item: UndoManager['undoStack'][number]) =>
    clients.some((client) => item.insertions.clients.has(client) || item.deletions.clients.has(client));
  // The body's one stack spans the note's manager and each payload's (undo.ts): drop from both levels.
  for (const manager of stack.managers) {
    manager.undoStack = manager.undoStack.filter((item) => !touches(item));
    manager.redoStack = manager.redoStack.filter((item) => !touches(item));
  }
  for (const steps of [stack.undone, stack.redone]) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      steps[i].entries = steps[i].entries.filter((entry) => !touches(entry.item));
      if (steps[i].entries.length === 0) steps.splice(i, 1);
    }
  }
}

/** Whether `role` may stay in `mode`: Review for any reader, Edit for any role but a suggester, Suggest from suggester. */
const allows = (mode: EditMode, role: Role | null): boolean =>
  role !== null && (mode === 'review' || (mode === 'edit' ? role !== 'suggester' : can(role, 'suggest')));

class PaneBinding implements SuggestPane {
  #state: PaneState = { docState: 'binding', bodyState: 'unbound', bodyVisible: false, resetting: false, revision: 0, hasText: false, mode: 'edit', suggestSent: 0, suggestRefused: 0 };
  readonly #listeners = new Set<() => void>();
  #session: DocSession | null = null;
  #editor: LexicalEditor | null = null;
  #fields: DocFields | null = null;
  #trashed = false;
  canWrite = true;
  #mode: EditMode;
  #mount: SuggestMount | ReviewMount | null = null;
  /** The mounted doc (F or C) is filled; Edit mode's B is ready at first sync. */
  #mountReady = true;
  /** Suggest input closed by a refusal until F is rebuilt. */
  #inputClosed = false;
  #reviewFallback = false;
  /** A remount is waiting for acks or underway: a mode switch, a rebuilt F or C. */
  #switching = false;
  #target: EditMode;
  #caret: CaretMark | null = null;
  readonly #mountListeners = new Set<() => void>();

  #role: Role | null;
  /** `fromTrash`: the editor holds the Trash view's REST content, which is cleared before the plugin binds. */
  constructor(readonly docId: string, fromTrash = false) {
    this.#role = knownRole(docId);
    this.#mode = modeFor(docId, this.#role);
    this.#target = this.#mode;
    this.#state = { ...this.#state, mode: this.#mode };
    if (fromTrash) this.#state = { ...this.#state, resetting: true };
  }

  /** Follows mode requests for this doc while the pane shows it; returns the release. */
  watchModes(): () => void {
    const stop = subscribeModes(() => this.#retarget());
    this.#retarget();
    return () => {
      stop();
      showMode(this.docId, null);
    };
  }

  setRole(role: Role | null): void {
    const known = this.#role !== null;
    this.#role = role;
    this.#retarget(known);
    if (this.#session) this.#apply(this.#session.state);
  }

  get mode(): EditMode {
    return this.#mode;
  }

  get mount(): SuggestMount | ReviewMount | null {
    return this.#mount;
  }

  get body(): Doc | null {
    return this.#session?.doc ?? null;
  }

  get bodyOpen(): boolean {
    return this.#state.bodyState === 'live' || this.#state.bodyState === 'readonly';
  }

  takeCaret(): CaretMark | null {
    // The editor leaving is not the one the caret goes back into.
    if (this.#switching) return null;
    const caret = this.#caret;
    this.#caret = null;
    return caret;
  }

  keepCaret(mark: CaretMark): void {
    this.#caret = mark;
  }

  readonly subscribeMount = (listener: () => void): (() => void) => {
    this.#mountListeners.add(listener);
    return () => this.#mountListeners.delete(listener);
  };

  #mountChanged(): void {
    const suggesting = this.#mount instanceof SuggestMount ? this.#mount : null;
    this.set({ suggestSent: suggesting?.fork.sent ?? 0, suggestRefused: suggesting?.refusals ?? 0 });
    for (const listener of [...this.#mountListeners]) listener();
  }

  /**
   * The mode the pane should show changed (a request, or the role): switch once every edit is acknowledged. A role
   * changed in place (a demotion) keeps the mode while the new role allows it, so a demoted editor stays on the body,
   * read-only, and is told why.
   */
  #retarget(roleChanged = false): void {
    if (roleChanged && allows(this.#target, this.#role)) return;
    const target = modeFor(this.docId, this.#role);
    if (target === this.#target) return;
    this.#target = target;
    if (!this.#session && !this.#switching) {
      this.#mode = target;
      this.set({ mode: target });
      return;
    }
    this.#remount();
  }

  /** Remounts the plugin on a fresh doc for the target mode once the DocDO acks every edit (§5 mode switches). */
  #remount(): void {
    if (this.#switching) return;
    this.#switching = true;
    const go = () => {
      // Kept on body text, which every mode's doc holds: never on a pending insert.
      const mount = this.#mount;
      const pending = mount instanceof SuggestMount ? mount.fork.ownClients() : mount instanceof ReviewMount ? new Set(mount.clients.keys()) : new Set<number>();
      if (this.#editor) this.#caret = captureCaret(this.#editor, pending) ?? this.#caret;
      this.#mode = this.#target;
      this.set({ resetting: true, mode: this.#mode });
    };
    const session = this.#session;
    if (!session || !session.state.unacked) {
      go();
      return;
    }
    const stop = session.subscribe((state) => {
      if (state.unacked) return;
      stop();
      go();
    });
  }

  /**
   * Called from the plugin's provider factory: the doc and provider this mount binds. Edit binds the session's B;
   * Suggest a fork F written as suggestion records; Review the composite C, read-only.
   */
  mountFor(session: DocSession): { doc: Doc; provider: Provider } {
    this.#mount = null;
    this.#inputClosed = false;
    this.#mountReady = this.#mode === 'edit';
    if (this.#mode === 'edit') return { doc: session.doc, provider: session.provider as unknown as Provider };
    if (this.#mode === 'suggest') {
      const state = auth.get();
      const me = state.status === 'signed-in' ? state.user.id : '';
      const mount: SuggestMount = new SuggestMount(session, me, {
        ready: () => {
          this.#mountReady = true;
          this.#apply(session.state);
          this.#mountChanged();
        },
        refused: (unsaved) => {
          // Input closes in this tick; F is rebuilt once the DocDO has answered everything in flight.
          this.#inputClosed = true;
          this.#editor?.setEditable(false);
          if (unsaved.length) offerUnsaved(this.docId, unsaved);
          this.#apply(session.state);
          this.#mountChanged();
          this.#remount();
        },
        rebuild: () => this.#remount(),
        closed: (event) => dropUndo(this.#editor, event.clients),
        change: () => this.#mountChanged(),
      });
      mount.editor = this.#editor;
      // A pane letting go with suggestions unanswered leaves the mount delivering them (A§10.1).
      aliasProvider(mount.provider, session, mount.doc, () => mount.retire((unsaved) => {
        if (unsaved.length) offerUnsaved(this.docId, unsaved);
      }));
      this.#mount = mount;
      return { doc: mount.doc, provider: mount.provider as unknown as Provider };
    }
    const mount: ReviewMount = new ReviewMount(session, this.#reviewFallback, {
      remount: (fallback) => {
        this.#reviewFallback = fallback;
        this.#remount();
      },
      change: () => {
        if (!this.#mountReady) {
          this.#mountReady = true;
          this.#apply(session.state);
        }
        this.#mountChanged();
      },
    });
    aliasProvider(mount.provider, session, mount.doc, () => mount.dispose());
    this.#mount = mount;
    return { doc: mount.doc, provider: mount.provider as unknown as Provider };
  }

  trash(trashed: boolean): void {
    this.#trashed = trashed;
    if (trashed && this.#session) this.#session.end('deleted');
  }

  readonly get = (): PaneState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  set(patch: Partial<PaneState>): void {
    if (Object.entries(patch).every(([key, value]) => this.#state[key as keyof PaneState] === value)) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Called from the plugin's provider factory with the session it opened. */
  attach(session: DocSession): void {
    this.#session = session;
    if (this.#trashed) session.end('deleted');
    this.set({ docState: 'binding' });
    showMode(this.docId, this.#mode);
    session.subscribe((state) => this.#apply(state));
    this.#apply(session.state);
    this.#mountChanged();
  }

  /** The gate's editor; the body opens once both it and the first sync are here. */
  bindEditor(editor: LexicalEditor): () => void {
    this.#editor = editor;
    if (this.#session) this.#apply(this.#session.state);
    const stop = subscribeTerminal(() => {
      if (this.#session) this.#apply(this.#session.state);
    });
    return () => {
      stop();
      if (this.#editor === editor) this.#editor = null;
    };
  }

  /** The pane's fields; bound now when the doc already synced. Returns the release. */
  attachFields(fields: DocFields): () => void {
    this.#fields = fields;
    const session = this.#session;
    if (session && this.#state.docState === 'live') fields.bind(session.docId, session.doc, () => this.#state.bodyState === 'live' && this.#mode === 'edit');
    return () => {
      if (this.#fields === fields) this.#fields = null;
      fields.unbind(this.#session?.doc ?? null);
    };
  }

  get bodyState(): BindingState {
    return this.#state.bodyState;
  }

  reset(editor: LexicalEditor): void {
    editor.update(() => {
      $getRoot().clear().append($createParagraphNode());
      $setSelection(null);
    }, { discrete: true });
    this.#session = null;
    this.#mount = null;
    this.#switching = false;
    this.set({ resetting: false, revision: this.#state.revision + 1, mode: this.#mode });
    this.#mountChanged();
    // A request made while this switch waited is served next.
    queueMicrotask(() => {
      if (this.#target !== this.#mode) this.#remount();
    });
  }

  #apply(state: SessionState): void {
    const editor = this.#editor;
    if (!editor) return;
    const terminal = terminalOf(this.docId);
    this.canWrite = state.canWrite;
    // Suggest writes only records, so a suggester's session (which cannot write the body) still types into F.
    const writes = this.#mode === 'edit' ? state.canWrite && can(this.#role, 'edit') : this.#mode === 'suggest' && can(this.#role, 'suggest') && !this.#inputClosed;
    const bodyState: BindingState = terminal ? 'terminal' : !state.synced || state.resync || !this.#role || !this.#mountReady ? 'unbound' : writes && !state.writePaused ? 'live' : 'readonly';
    editor.setEditable(bodyState === 'live');
    closeRoot(editor.getRootElement(), bodyState);
    editor.getRootElement()?.closest(`[${EDITOR_PANE_ATTR}]`)?.setAttribute(SYNC_UNACKED_ATTR, state.unacked ? '1' : '0');
    const session = this.#session;
    if (session && state.synced && !state.resync) this.#fields?.bind(session.docId, session.doc, () => this.#state.bodyState === 'live' && this.#mode === 'edit');
    this.set({
      bodyState,
      bodyVisible: state.synced && !state.resync && this.#mountReady,
      resetting: state.resync || (this.#switching && this.#state.resetting),
      docState: terminal ? 'terminal' : state.retrying ? 'retrying' : !state.synced || state.resync ? 'binding' : state.connection === 'offline' ? 'offline' : 'live',
    });
  }
}

/** Lexical gives every checklist item tabindex=-1 on each render; a closed body offers no checkbox (T2.6, R2). */
const CHECK_ITEM = 'li[role="checkbox"]';

function gateCheckItems(root: HTMLElement, live: boolean): void {
  for (const item of root.querySelectorAll(CHECK_ITEM)) {
    if (live) item.setAttribute('tabindex', '-1');
    else item.removeAttribute('tabindex');
  }
}

/** Closed until live: `@lexical/react` gives a non-editable root tabindex=-1, which would let it take focus (R2). */
function closeRoot(root: HTMLElement | null, state: BindingState): void {
  if (!root) return;
  root.setAttribute(BODY_BINDING_ATTR, state);
  gateCheckItems(root, state === 'live');
  if (state === 'live') {
    root.removeAttribute('aria-disabled');
    return;
  }
  const focused = root.ownerDocument.activeElement;
  if (focused instanceof HTMLElement && root.contains(focused)) focused.blur();
  root.removeAttribute('tabindex');
  root.setAttribute('aria-disabled', 'true');
}

const hasText = (state: EditorState): boolean =>
  state.read(() => {
    const root = $getRoot();
    return root.getChildrenSize() > 1 || (root.getFirstChild()?.getTextContentSize() ?? 0) > 0;
  });

/** Inside the composer: binds the editor to the pane and keeps the root's attributes. */
function BindingGate({ binding }: { binding: PaneBinding }): null {
  const [editor] = useLexicalComposerContext();
  const body = usePaneState(binding).bodyState;
  // After the commit that made the root editable, before moss's pending focus runs (a parent's layout effect).
  useLayoutEffect(() => {
    const root = editor.getRootElement();
    if (root) closeRoot(root, body);
  }, [body, editor]);
  useLayoutEffect(() => {
    const value = String(generation(editor));
    const stopRoot = editor.registerRootListener((root) => {
      if (!root) return;
      root.setAttribute(EDITOR_GENERATION_ATTR, value);
      closeRoot(root, binding.bodyState);
    });
    const unbind = binding.bindEditor(editor);
    const stopText = editor.registerUpdateListener(({ editorState }) => {
      binding.set({ hasText: hasText(editorState) });
      const root = editor.getRootElement();
      if (root && binding.bodyState !== 'live') gateCheckItems(root, false);
    });
    return () => {
      stopText();
      unbind();
      stopRoot();
      editor.getRootElement()?.closest(`[${EDITOR_PANE_ATTR}]`)?.removeAttribute(SYNC_UNACKED_ATTR);
    };
  }, [binding, editor]);
  return null;
}

/**
 * The vendored V1 plugin with this pane's session, in its own collaboration context (A§10.1: never shared). While
 * another pane of the tab holds the doc, this pane mounts no plugin and stays closed; it binds once the doc is free.
 */
function DocBinding({ docId, binding }: { docId: string; binding: PaneBinding }): ReactNode {
  const [editor] = useLexicalComposerContext();
  useEffect(() => trackUndoFocus(editor), [editor]);
  const [excluded] = useState(() => excludedPropertiesFor(editor));
  const [identity] = useState(localIdentity);
  const [cursors] = useState(() => cursorController(editor));
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [overlayReady, setOverlayReady] = useState(false);
  useLayoutEffect(() => editor.registerRootListener(root => {
    overlayRef.current?.remove();
    overlayRef.current = null;
    if (!root?.parentElement) { setOverlayReady(false); return; }
    const overlay = document.createElement('div');
    overlay.dataset.cursorOverlay = '';
    overlay.style.pointerEvents = 'none';
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    if (getComputedStyle(root.parentElement).position === 'static') root.parentElement.style.position = 'relative';
    root.parentElement.appendChild(overlay);
    overlayRef.current = overlay;
    setOverlayReady(true);
  }), [editor]);
  useEffect(() => () => { overlayRef.current?.remove(); }, []);
  const { resetting, revision } = usePaneState(binding);
  useEffect(() => {
    if (resetting) binding.reset(editor);
  }, [binding, editor, resetting]);
  const owner = useSyncExternalStore(subscribeDocOwners, () => docOwner(docId));
  const providerFactory = useCallback(
    (id: string, docMap: Map<string, Doc>): Provider => {
      const session = openDocSession(id, binding, binding.canWrite);
      // Refused when another pane took the doc in the same commit: the plugin renders nothing without a provider,
      // and the owner gate above unmounts it until the doc is free.
      if (!session) return undefined as unknown as Provider;
      binding.attach(session);
      const mounted = binding.mountFor(session);
      docMap.set(id, mounted.doc);
      if (!session.stopPresence) {
        const stopPresence = startPresence(id, session.provider);
        const stopCursors = cursors.start(session.provider);
        session.stopPresence = () => { stopPresence(); stopCursors(); };
      }
      return mounted.provider;
    },
    [binding, cursors],
  );
  return (
    <LexicalCollaboration>
      {overlayReady && !resetting && (owner === null || owner === binding) ? (
        <CollaborationPlugin
          key={revision}
          id={docId}
          providerFactory={providerFactory}
          shouldBootstrap={false}
          username={identity.name}
          cursorColor={identity.color}
          awarenessData={identity.awarenessData}
          excludedProperties={excluded}
          cursorsContainerRef={overlayRef}
          syncCursorPositionsFn={cursors.sync}
        />
      ) : null}
      <BindingGate binding={binding} />
      <SuggestPlugin pane={binding} />
    </LexicalCollaboration>
  );
}

export interface MossMultiPane {
  /** Every note the web opens is bound to its doc, so moss's REST content paths never run; a note opened from
   * Trash is the one exception, read-only. */
  bound: boolean;
  /** MarkdownEditor's `collaboration` prop; `backgroundWriters` is false outside Edit mode. */
  collaboration: { plugin: ReactNode; backgroundWriters: boolean } | null;
  /** The body is bound, synced and editable; moss's pending body focus waits for it. */
  bodyLive: boolean;
  /** Synced content stays visible when editing pauses or the session ends. */
  bodyVisible: boolean;
  /** The title opens with the body: bound to its doc's Y.Text('title') and synced (A§10.4, R2). */
  titleLive: boolean;
  titleBinding: BindingState;
  /** The title field's binding; CanvasAreaContent's input, paste, drop and emoji paths write through it. */
  title: TitleField;
  hasBodyText: boolean;
  /** The pane root's A§19 attributes. */
  paneProps: Record<string, string>;
  /** Web chrome at the start of the top bar's right group. */
  topBarCollab: ReactNode;
  noticeBand: ReactNode;
  readOnly: boolean;
}

/**
 * Whether the pane shows `docId` as the Trash view. A trashed note is shown that way unless this pane already shows
 * its synced content, which then stays in place, terminal. A restore, from the view or in place, starts a fresh
 * binding: `epoch` counts restores so each one gets its own.
 */
function useTrashView(docId: string | null, trashed: boolean, synced: boolean): { trashView: boolean; restored: boolean; epoch: number } {
  const mode = useRef({ docId, trashed, trashView: trashed, restored: false, epoch: 0 });
  const current = mode.current;
  if (current.docId !== docId) mode.current = { docId, trashed, trashView: trashed, restored: false, epoch: 0 };
  else if (current.trashed && !trashed) mode.current = { docId, trashed, trashView: false, restored: true, epoch: current.epoch + 1 };
  else if (!current.trashed && trashed) mode.current = { ...current, trashed, trashView: current.trashView || !synced };
  return mode.current;
}

export function useMossMultiPane(note: { id: string; trashedAt?: number | null } | null): MossMultiPane {
  const docId = note?.id ?? null;
  const store = useStore();
  const [fields] = useState(() => new DocFields(store));
  const role = useDocRole(docId);
  // The bridge learns of a trash before moss's note record does, so a pane opening that note never binds it.
  const trashed = note?.trashedAt != null || (docId !== null && getBridge()?.[WORKSPACE].isTrashed(docId) === true);
  const synced = useRef<{ docId: string | null; synced: boolean }>({ docId, synced: false });
  if (synced.current.docId !== docId) synced.current = { docId, synced: false };
  const { trashView, restored, epoch } = useTrashView(docId, trashed, synced.current.synced);
  // A fresh binding for every doc the pane shows and every restore of it, none for the Trash view.
  const binding = useMemo(() => (docId && !trashView ? new PaneBinding(docId, restored) : null), [docId, trashView, restored, epoch]);
  useLayoutEffect(() => { binding?.trash(trashed); }, [binding, trashed]);
  useEffect(() => binding?.watchModes(), [binding]);
  useLayoutEffect(() => binding?.setRole(role), [binding, role]);
  const state = usePaneState(binding);
  if (state.bodyVisible) synced.current.synced = true;
  const terminal = useTerminal(docId);
  const plugin = useMemo(
    () => (docId && binding ? <DocBinding key={`${docId}:${epoch}`} docId={docId} binding={binding} /> : null),
    [binding, docId, epoch],
  );
  // Moss's background writers (A§10.10) run only in Edit: in Suggest they would record their own rewrites (§5).
  const backgroundWriters = state.mode === 'edit';
  const collaboration = useMemo(() => (plugin ? { plugin, backgroundWriters } : null), [plugin, backgroundWriters]);
  const live = state.bodyState === 'live' && !terminal;
  // The title and Properties are the body's own fields: read-only while suggesting or reviewing (§5).
  const titleLive = live && state.mode === 'edit';
  useLayoutEffect(() => fields.title.show(docId), [fields, docId]);
  useLayoutEffect(() => binding?.attachFields(fields), [binding, fields]);
  useLayoutEffect(() => fields.title.setOpen(titleLive), [fields, titleLive]);
  if (docId && trashView) {
    return {
      bound: false,
      readOnly: true,
      noticeBand: <ConnectionNotice docId={null} />,
      collaboration: null,
      bodyLive: false,
      bodyVisible: true,
      titleLive: false,
      titleBinding: 'readonly',
      title: fields.title,
      hasBodyText: false,
      paneProps: { [EDITOR_PANE_ATTR]: '', [DOC_ID_ATTR]: docId, [DOC_STATE_ATTR]: 'terminal', [TERMINAL_REASON_ATTR]: 'deleted' },
      topBarCollab: null,
    };
  }
  return {
    bound: true,
    readOnly: !live,
    noticeBand: <><ConnectionNotice docId={docId} /><SuggestUnsavedBand docId={docId} /></>,
    collaboration,
    bodyLive: live,
    bodyVisible: state.bodyVisible,
    titleLive,
    titleBinding: terminal ? 'terminal' : titleLive ? 'live' : live ? 'readonly' : state.bodyState,
    title: fields.title,
    hasBodyText: state.hasText,
    paneProps: docId
      ? {
          [EDITOR_PANE_ATTR]: '',
          [DOC_ID_ATTR]: docId,
          ...(role ? { [ROLE_ATTR]: role } : {}),
          [EDIT_MODE_ATTR]: state.mode,
          ...(state.mode === 'suggest' ? { [SUGGEST_SENT_ATTR]: String(state.suggestSent), [SUGGEST_REFUSED_ATTR]: String(state.suggestRefused) } : {}),
          [DOC_STATE_ATTR]: terminal ? 'terminal' : state.docState,
          ...(terminal ? { [TERMINAL_REASON_ATTR]: terminal } : {}),
        }
      : {},
    topBarCollab: docId ? <><SuggestModeChip docId={docId} /><TopBarCollab docId={docId} /></> : null,
  };
}

const CLOSED: PaneState = { docState: 'binding', bodyState: 'unbound', bodyVisible: false, resetting: false, revision: 0, hasText: false, mode: 'edit', suggestSent: 0, suggestRefused: 0 };

/**
 * The binding's state as React state rather than a store snapshot: going live must commit in the same render as the
 * editor's own editable flip, so the pending focus finds an editable root; a useSyncExternalStore update would
 * render first, on its own.
 */
function usePaneState(binding: PaneBinding | null): PaneState {
  const [seen, setSeen] = useState(() => ({ binding, state: binding?.get() ?? CLOSED }));
  useEffect(() => {
    if (!binding) return;
    const update = () => setSeen({ binding, state: binding.get() });
    update();
    return binding.subscribe(update);
  }, [binding]);
  return seen.binding === binding ? seen.state : (binding?.get() ?? CLOSED);
}
