// The one pane hook (A§2.2): CanvasAreaContent calls useMossMultiPane(note) once and reads from it everything a bound
// pane needs: the binding plugin MarkdownEditor mounts in place of its history, the first-sync gate (A§10.3), the
// readiness attributes (A§19), the title and Properties bindings (A§10.4), the top-bar collab slot and the terminal
// reason.
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { Provider } from '@lexical/yjs';
import { CollaborationPlugin } from '@moss-multi/lexical-react/LexicalCollaborationPlugin';
import {
  BODY_BINDING_ATTR, DOC_ID_ATTR, DOC_STATE_ATTR, EDITOR_GENERATION_ATTR, EDITOR_PANE_ATTR, SYNC_UNACKED_ATTR,
  TERMINAL_REASON_ATTR, ROLE_ATTR, type BindingState, type DocState,
} from '@moss-multi/protocol/dom-contract';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { syncNoteEntityAtom } from '@moss/shared/state/atoms';
import { useStore } from 'jotai';
import { $createParagraphNode, $getRoot, $setSelection, type EditorState, type LexicalEditor } from 'lexical';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Doc } from 'yjs';
import { can, type Role } from '@moss-multi/protocol/roles';
import { knownRole, useDocRole } from '../access.ts';
import { TopBarCollab } from '../slots.tsx';
import {
  docOwner, openDocSession, subscribeDocOwners, type DocSession, type SessionState,
} from './doc-session.ts';
import { bindFrontmatter } from './frontmatter-binding.ts';
import { displayTitle, TitleField } from './title-binding.ts';
import { localIdentity } from './presence.ts';
import { subscribeTerminal, terminalOf, useTerminal } from './terminal.ts';
import { ConnectionNotice } from './ConnectionNotice.tsx';

interface PaneState {
  docState: DocState;
  bodyState: BindingState;
  bodyVisible: boolean;
  resetting: boolean;
  revision: number;
  /** The body holds any text; moss reads its markdown string for this, which a bound note never fills. */
  hasText: boolean;
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
    const updated = () => this.store.set(syncNoteEntityAtom, { noteId: docId, updates: { updatedAt: Math.floor(Date.now() / 1000) } });
    doc.on('update', updated);
    this.#frontmatter = { doc, stop: () => { stop(); doc.off('update', updated); } };
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
class PaneBinding {
  #state: PaneState = { docState: 'binding', bodyState: 'unbound', bodyVisible: false, resetting: false, revision: 0, hasText: false };
  readonly #listeners = new Set<() => void>();
  #session: DocSession | null = null;
  #editor: LexicalEditor | null = null;
  #fields: DocFields | null = null;
  #trashed = false;
  canWrite = true;

  #role: Role | null;
  constructor(readonly docId: string) { this.#role = knownRole(docId); }

  setRole(role: Role | null): void {
    this.#role = role;
    if (this.#session) this.#apply(this.#session.state);
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
    session.subscribe((state) => this.#apply(state));
    this.#apply(session.state);
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
    if (session && this.#state.docState === 'live') fields.bind(session.docId, session.doc, () => this.#state.bodyState === 'live');
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
    this.set({ resetting: false, revision: this.#state.revision + 1 });
  }

  #apply(state: SessionState): void {
    const editor = this.#editor;
    if (!editor) return;
    const terminal = terminalOf(this.docId);
    this.canWrite = state.canWrite;
    const bodyState: BindingState = terminal ? 'terminal' : !state.synced || state.resync || !this.#role ? 'unbound' : state.canWrite && can(this.#role, 'edit') && !state.halted && !state.writePaused ? 'live' : 'readonly';
    editor.setEditable(bodyState === 'live');
    closeRoot(editor.getRootElement(), bodyState);
    editor.getRootElement()?.closest(`[${EDITOR_PANE_ATTR}]`)?.setAttribute(SYNC_UNACKED_ATTR, state.unacked ? '1' : '0');
    const session = this.#session;
    if (session && state.synced && !state.resync) this.#fields?.bind(session.docId, session.doc, () => this.#state.bodyState === 'live');
    this.set({
      bodyState,
      bodyVisible: state.synced && !state.resync,
      resetting: state.resync,
      docState: terminal ? 'terminal' : state.retrying ? 'retrying' : !state.synced || state.resync ? 'binding' : state.connection === 'offline' ? 'offline' : 'live',
    });
  }
}

/** Closed until live: `@lexical/react` gives a non-editable root tabindex=-1, which would let it take focus (R2). */
function closeRoot(root: HTMLElement | null, state: BindingState): void {
  if (!root) return;
  root.setAttribute(BODY_BINDING_ATTR, state);
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
    const stopText = editor.registerUpdateListener(({ editorState }) => binding.set({ hasText: hasText(editorState) }));
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
  const [excluded] = useState(() => excludedPropertiesFor(editor));
  const [identity] = useState(localIdentity);
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
      docMap.set(id, session.doc);
      binding.attach(session);
      return session.provider as unknown as Provider;
    },
    [binding],
  );
  return (
    <LexicalCollaboration>
      {!resetting && (owner === null || owner === binding) ? (
        <CollaborationPlugin
          key={revision}
          id={docId}
          providerFactory={providerFactory}
          shouldBootstrap={false}
          username={identity.name}
          cursorColor={identity.color}
          awarenessData={identity.awarenessData}
          excludedProperties={excluded}
        />
      ) : null}
      <BindingGate binding={binding} />
    </LexicalCollaboration>
  );
}

export interface MossMultiPane {
  /** Every note the web opens is bound to its doc; moss's REST content paths never run. */
  bound: true;
  /** MarkdownEditor's `collaboration` prop. */
  collaboration: { plugin: ReactNode } | null;
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

export function useMossMultiPane(note: { id: string; trashedAt?: number | null } | null): MossMultiPane {
  const docId = note?.id ?? null;
  const store = useStore();
  const [fields] = useState(() => new DocFields(store));
  const role = useDocRole(docId);
  // A fresh binding for every doc the pane shows.
  const binding = useMemo(() => (docId ? new PaneBinding(docId) : null), [docId]);
  useLayoutEffect(() => { binding?.trash(note?.trashedAt != null); }, [binding, note?.trashedAt]);
  useLayoutEffect(() => binding?.setRole(role), [binding, role]);
  const state = usePaneState(binding);
  const terminal = useTerminal(docId);
  const collaboration = useMemo(
    () => (docId && binding ? { plugin: <DocBinding key={docId} docId={docId} binding={binding} /> } : null),
    [binding, docId],
  );
  const live = state.bodyState === 'live' && !terminal;
  useLayoutEffect(() => fields.title.show(docId), [fields, docId]);
  useLayoutEffect(() => binding?.attachFields(fields), [binding, fields]);
  useLayoutEffect(() => fields.title.setOpen(live), [fields, live]);
  return {
    bound: true,
    readOnly: !live,
    noticeBand: <ConnectionNotice docId={docId} />,
    collaboration,
    bodyLive: live,
    bodyVisible: state.bodyVisible,
    titleLive: live,
    titleBinding: terminal ? 'terminal' : live ? 'live' : state.bodyState,
    title: fields.title,
    hasBodyText: state.hasText,
    paneProps: docId
      ? {
          [EDITOR_PANE_ATTR]: '',
          [DOC_ID_ATTR]: docId,
          ...(role ? { [ROLE_ATTR]: role } : {}),
          [DOC_STATE_ATTR]: terminal ? 'terminal' : state.docState,
          ...(terminal ? { [TERMINAL_REASON_ATTR]: terminal } : {}),
        }
      : {},
    topBarCollab: docId ? <TopBarCollab docId={docId} /> : null,
  };
}

const CLOSED: PaneState = { docState: 'binding', bodyState: 'unbound', bodyVisible: false, resetting: false, revision: 0, hasText: false };

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
