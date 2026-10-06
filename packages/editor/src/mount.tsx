// mountMossEditor: moss's own MarkdownEditor, editable, under a contenteditable title, on the canvas moss paints a
// note on, with moss's comment UI. Each editor has its own Jotai store. The surface below is what the session
// (session.ts) drives: it loads a note's layers into moss, and on each save hands back what moss's renderer would
// send (`buildMarkdownForSave`, the pruned comment metadata, the layout widths), read straight from the editor.
import { StrictMode, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type SyntheticEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import {
  $addUpdateTag,
  $getRoot,
  $getSelection,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SCROLL_INTO_VIEW_TAG,
  type LexicalEditor,
} from 'lexical';
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown';
import {
  $collectTabGroupLayoutMetadata,
  $collectTableLayoutMetadata,
  $postImportNormalize,
  MARKDOWN_EDITOR_TRANSFORMERS,
  MarkdownEditor,
  escapeHtmlEntities,
  normalizeMarkdownForImport,
  type MarkdownEditorHandle,
} from '@moss-desktop/renderer/editor/MarkdownEditor';
import { CanvasArea } from '@moss/shared/components/layout/CanvasArea';
import { commentDirtySignalAtom, noteCommentsMapAtom, noteEntityAtom, noteIdsAtom } from '@moss/shared/state/note-atoms';
import { browserSplitTargetAtom, mapNoteMetadataToNoteEntity, splitTabNoteIdAtom, webEmbedLightboxTargetAtom } from '@moss/shared/state/atoms';
import { collectReachableCommentThreadIds, extractCommentAnchorIds } from '@moss-desktop/common/markdown-layers';
import { buildCommentMetadata } from '@moss-desktop/renderer/editor/utils/comment-export';
import { hydrateComments } from '@moss-desktop/renderer/editor/utils/comment-import';
import { flushDecoratorDrafts } from '@moss-desktop/renderer/editor/utils/decoratorDraftRegistry';
import {
  DIRTY_TRACKER_CONTENT_TAGS,
  DIRTY_TRACKER_IGNORED_TAGS,
  hasTrackedEditorUpdateTag,
} from '@moss-desktop/renderer/editor/utils/editorUpdateTags';
import { setEmbedTheme } from '@moss-multi/host/embed-theme.ts';
import { linesBeforeBody, offsetLines, readSelection } from '@moss-multi/host/selection.ts';
import { ShareWithAgentBar, shareSelection } from '@moss-multi/host/share-with-agent.tsx';
import type { MossEditorHandle, MossEditorNote, MossEditorOptions, MossEditorServices, MossEditorTheme, MossSelection } from './contract';
import { assembleContent, type EditorContent, type RendererSnapshot } from './desktop/pipeline';
import { noteIdKey } from './host/moss-editor-host.js';
import { installEditorElectronApi } from './electron-api';
import { installEditorHooks } from './hooks';
import { MOSS_EDITOR_INFO } from './info';
import { markActive, registerEditor } from './registry';
import { $holdSelection, $restoreSelection, type HeldSelection } from './selection-map';
import { MOSS_EXPORT, finishBody } from './selection';
import { EditorSession, type SessionSurface, type SessionView } from './session';

type Store = ReturnType<typeof createStore>;

const nextFrame = () =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, 120);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        done();
      }),
    );
  });

interface PaneState {
  content: EditorContent | null;
  /** Bumped to remount moss's editor on a first load. */
  version: number;
  view: SessionView;
  editable: boolean;
  /** Unmount is waiting for its final write: no input lands, comment replies included. */
  frozen: boolean;
}

/** The session's surface: moss's editor behind a small external store the pane renders from. */
class FrameSurface implements SessionSurface {
  editor: LexicalEditor | null = null;
  handle: MarkdownEditorHandle | null = null;
  title: HTMLDivElement | null = null;
  scroller: HTMLDivElement | null = null;
  session: EditorSession | null = null;
  private committedTitle = '';
  /** Changes from a load, moss's own post-mount transforms included, are not the user's edits. */
  private settling = true;
  private pendingReady: (() => void) | null = null;
  private stopUpdates: (() => void) | null = null;
  private stopComments: (() => void) | null = null;
  /** The caret and focus when the editor last went read-only, which an in-place load carries over. */
  private held: { selection: HeldSelection | null; focused: boolean } | null = null;
  /** What to select once the editor is editable again after an in-place load. */
  private restore: { selection: HeldSelection; focused: boolean } | null = null;
  private state: PaneState = { content: null, version: 0, view: { status: 'loading', conflict: null, overwritten: false, error: null, removed: null }, editable: false, frozen: false };
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: Store,
    private readonly noteId: string,
    private readonly host: HTMLElement,
  ) {
    this.stopComments = store.sub(commentDirtySignalAtom(noteId), () => this.edited());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(next: Partial<PaneState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  private edited() {
    if (!this.settling) this.session?.markEdited();
  }

  private hydrateComments(content: EditorContent) {
    this.store.set(noteCommentsMapAtom(this.noteId), hydrateComments(content.commentMetadata, content.commentColors));
  }

  async load(content: EditorContent, options: { keepView: boolean }): Promise<void> {
    this.settling = true;
    this.committedTitle = content.title;
    this.hydrateComments(content);
    // The session commits a focused title before it reloads, so the title shown is the one loaded, focused or not.
    if (this.title && this.title.textContent !== content.title) this.title.textContent = content.title;
    if (options.keepView && this.editor) {
      const replaced = this.replaceBody(this.editor, content);
      this.set({ content });
      if (replaced) {
        this.hydrateComments(content);
        await nextFrame();
        this.settling = false;
        return;
      }
    }
    // A first load, or an in-place update moss refused: mount moss's editor on the note.
    const ready = new Promise<void>((resolve) => {
      this.pendingReady = resolve;
    });
    this.set({ content, version: this.state.version + 1 });
    await ready;
  }

  /**
   * MarkdownEditor's updateContentFromMarkdown (MarkdownEditor.tsx:4176-4265) on a body the pipeline already split:
   * that handle strips frontmatter, a footer and a leading H1 again, which would drop a body's own first heading.
   */
  private replaceBody(editor: LexicalEditor, content: EditorContent): boolean {
    const selection = this.held ? this.held.selection : editor.getEditorState().read($holdSelection, { editor });
    const focused = this.held ? this.held.focused : this.focused(editor);
    const scroller = this.scroller;
    const top = scroller?.scrollTop ?? 0;
    const lock = () => {
      if (scroller) scroller.scrollTop = top;
    };
    scroller?.addEventListener('scroll', lock);
    const release = () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          scroller?.removeEventListener('scroll', lock);
          lock();
        }),
      );
    try {
      editor.update(
        () => {
          $addUpdateTag(SKIP_DOM_SELECTION_TAG);
          $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
          if ($getSelection() !== null) $setSelection(null);
          $getRoot().clear();
          $convertFromMarkdownString(escapeHtmlEntities(normalizeMarkdownForImport(content.body)), MARKDOWN_EDITOR_TRANSFORMERS);
          $postImportNormalize(content.commentMetadata, undefined, { layoutMetadata: content.layoutMetadata });
        },
        { tag: 'agent-content-update' },
      );
      // As desktop's applyDiskUpdate (clearHistory: true): Undo must not bring back the text the disk replaced.
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      release();
      // Lexical places the DOM selection only while editable, so the caret comes back in setEditable(true).
      this.restore = selection ? { selection, focused } : null;
      return true;
    } catch (error) {
      scroller?.removeEventListener('scroll', lock);
      console.error('[moss-editor] in-place update failed:', error);
      return false;
    }
  }

  attach = (editor: LexicalEditor) => {
    this.stopUpdates?.();
    this.editor = editor;
    editor.setEditable(this.state.editable);
    let skippedBootstrapUpdate = false;
    // CanvasAreaContent.tsx:4122-4153, desktop's dirty tracking.
    this.stopUpdates = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, tags }) => {
      const hasDirtyMutations = dirtyElements.size > 0 || dirtyLeaves.size > 0;
      const hasContentUpdateTag = hasTrackedEditorUpdateTag(tags, DIRTY_TRACKER_CONTENT_TAGS);
      if (!skippedBootstrapUpdate) {
        skippedBootstrapUpdate = true;
        if (!hasDirtyMutations && !hasContentUpdateTag) return;
      }
      if (hasTrackedEditorUpdateTag(tags, DIRTY_TRACKER_IGNORED_TAGS)) return;
      if (hasDirtyMutations || hasContentUpdateTag) this.edited();
    });
    void nextFrame().then(() => {
      this.settling = false;
      const resolve = this.pendingReady;
      this.pendingReady = null;
      resolve?.();
    });
  };

  /** The title commits on blur, Enter and Tab, as desktop's does (CanvasAreaContent.tsx:4240-4258). */
  commitTitle = () => {
    const live = this.title?.textContent ?? this.committedTitle;
    if (live === this.committedTitle) return;
    this.committedTitle = live;
    this.session?.markEdited();
  };

  async commit(): Promise<void> {
    this.commitTitle();
    flushDecoratorDrafts();
    // Lexical commits the drafts' updates in a microtask; the update listener then counts them.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  snapshot(): RendererSnapshot | null {
    const content = this.state.content;
    if (!this.editor || !content) return null;
    this.commitTitle();
    // getEditorBodyMarkdown (CanvasAreaContent.tsx:1967-2015).
    let markdownBody = content.body;
    let layoutMetadata: RendererSnapshot['layoutMetadata'] = { version: 1, tableCount: 0, tables: [] };
    this.editor.getEditorState().read(
      () => {
        markdownBody = $convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS);
        layoutMetadata = { ...$collectTableLayoutMetadata(), ...$collectTabGroupLayoutMetadata() };
      },
      { editor: this.editor },
    );
    markdownBody = finishBody(markdownBody);
    // pruneCommentsWithoutAnchors (2027-2067): replies survive with their root's anchor.
    const commentsMap = this.store.get(noteCommentsMapAtom(this.noteId));
    const anchorIds = extractCommentAnchorIds(markdownBody);
    const surviving = Object.keys(commentsMap).length === 0 || anchorIds.size === 0 ? new Set<string>() : collectReachableCommentThreadIds(anchorIds, commentsMap);
    const currentCommentsMap = Object.fromEntries(Object.entries(commentsMap).filter(([id]) => surviving.has(id)));
    const commentColors = Object.fromEntries(
      Object.entries(currentCommentsMap)
        .filter(([, comment]) => comment.color !== undefined)
        .map(([id, comment]) => [id, comment.color as number]),
    );
    return {
      content: assembleContent(content, { title: this.committedTitle, body: markdownBody }),
      commentMetadata: buildCommentMetadata(currentCommentsMap),
      layoutMetadata,
      intents: { frontmatterMetaUpdates: {}, commentColors },
    };
  }

  /** The selection in the body, its lines counted in the file a save would write now (selection.ts). */
  selection(): MossSelection | null {
    const content = this.state.content;
    if (!this.editor || !content) return null;
    const title = this.title?.textContent ?? this.committedTitle;
    return readSelection(this.editor, MOSS_EXPORT, (body) => offsetLines(linesBeforeBody(assembleContent(content, { title, body }), body) ?? 0));
  }

  private focused(editor: LexicalEditor): boolean {
    const root = editor.getRootElement();
    return Boolean(root && document.activeElement && root.contains(document.activeElement));
  }

  /** The element in this editor's React tree, portals included, that last took focus. */
  focusTarget: HTMLElement | null = null;
  /** Body-level containers of moss's portalled popovers that this editor's React tree has used. */
  private readonly portals = new Set<HTMLElement>();
  private unfreeze: (() => void) | null = null;

  /** Records the body-level container of an event target outside the root (React events bubble through portals). */
  notePortal(target: EventTarget | null): void {
    for (const portal of this.portals) if (!portal.isConnected) this.portals.delete(portal);
    if (!(target instanceof Node) || this.host.contains(target)) return;
    let el: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement;
    while (el?.parentElement && el.parentElement !== document.body) el = el.parentElement;
    if (el?.parentElement === document.body && !el.contains(this.host)) this.portals.add(el);
  }

  freeze(frozen: boolean): void {
    this.unfreeze?.();
    this.unfreeze = null;
    if (frozen) {
      // inert covers the root and the containers of moss's popovers (the comment composer, replies, menus), which
      // portal into document.body; native capture listeners cancel any input still aimed at either, and whatever of
      // them holds focus lets go. EditorPane's capture handlers also catch a popover not seen before.
      const owned = (node: EventTarget | null) =>
        node instanceof Node && (this.host.contains(node) || node === this.focusTarget || [...this.portals].some((portal) => portal.contains(node)));
      const active = document.activeElement;
      if (active instanceof HTMLElement && owned(active)) active.blur();
      const inerted = [...this.portals].filter((portal) => portal.isConnected && !portal.inert);
      for (const portal of inerted) portal.inert = true;
      const block = (event: Event) => {
        if (!owned(event.target)) return;
        if (event.type === 'focusin') (event.target as HTMLElement).blur?.();
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const types = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'textInput', 'compositionstart', 'paste', 'cut', 'drop', 'pointerdown', 'mousedown', 'click', 'submit', 'focusin'];
      for (const type of types) window.addEventListener(type, block, true);
      this.unfreeze = () => {
        for (const type of types) window.removeEventListener(type, block, true);
        for (const portal of inerted) portal.inert = false;
      };
    }
    this.set({ frozen });
  }

  setEditable(editable: boolean): void {
    const editor = this.editor;
    if (!editable && editor && editor.isEditable() && !this.held) {
      this.held = { selection: editor.getEditorState().read($holdSelection, { editor }), focused: this.focused(editor) };
    }
    editor?.setEditable(editable);
    this.set({ editable });
    if (!editable) return;
    const restore = this.restore;
    this.held = null;
    this.restore = null;
    // The caret goes back on the same text, only when the body had focus, so a focused title or the host keeps it.
    if (!editor || !restore?.focused) return;
    editor.getRootElement()?.focus({ preventScroll: true });
    editor.update(() => {
      $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
      $restoreSelection(restore.selection);
    });
  }

  /** meta.json's colors changed on disk: a comment whose color the user has not changed takes the new one. */
  adoptCommentColors(previous: Record<string, number> | undefined, next: Record<string, number> | undefined): void {
    const atom = noteCommentsMapAtom(this.noteId);
    const current = this.store.get(atom);
    let changed = false;
    const updated = Object.fromEntries(
      Object.entries(current).map(([id, comment]) => {
        const color = next?.[id];
        if (comment.color !== previous?.[id] || comment.color === color) return [id, comment];
        changed = true;
        const recolored = { ...comment, color };
        if (color === undefined) delete recolored.color;
        return [id, recolored];
      }),
    );
    if (changed) this.store.set(atom, updated);
  }

  view(view: SessionView): void {
    this.host.dataset.mossEditorStatus = view.status;
    this.set({ view });
  }

  dispose() {
    this.unfreeze?.();
    this.unfreeze = null;
    this.stopUpdates?.();
    this.stopComments?.();
  }
}

function setNotes(store: Store, notes: readonly MossEditorNote[]): void {
  for (const note of notes) {
    store.set(
      noteEntityAtom(note.id),
      mapNoteMetadataToNoteEntity({ id: note.id, title: note.title, createdAt: note.updatedAt ?? 0, updatedAt: note.updatedAt ?? 0, folderPath: note.folderPath ?? 'Notes' }),
    );
  }
  store.set(noteIdsAtom, new Set(notes.map((note) => note.id)));
}

/** Moss opens web links in its browser split or lightbox, and notes in a split; an editor hands each to its host. */
function routeNavigation(store: Store, noteId: string, services: MossEditorServices): () => void {
  const toUrl = (target: typeof browserSplitTargetAtom | typeof webEmbedLightboxTargetAtom) =>
    store.sub(target, () => {
      const request = store.get(target);
      if (!request) return;
      store.set(target, null);
      services.navigate?.({ kind: 'url', url: request.url, title: request.title });
    });
  const stops = [
    toUrl(browserSplitTargetAtom),
    toUrl(webEmbedLightboxTargetAtom),
    store.sub(splitTabNoteIdAtom, () => {
      const target = store.get(splitTabNoteIdAtom);
      if (!target) return;
      store.set(splitTabNoteIdAtom, null);
      if (target !== noteId) services.navigate?.({ kind: 'note', noteId: target, heading: null });
    }),
  ];
  return () => stops.forEach((stop) => stop());
}

const BUTTON = 'rounded-md px-2.5 py-1 text-small font-medium transition-colors';

function Banner({ view, session }: { view: SessionView; session: EditorSession }): ReactNode {
  const [kept, setKept] = useState(false);
  useEffect(() => {
    if (!view.conflict) setKept(false);
  }, [view.conflict]);
  if (view.conflict) {
    return (
      <div data-moss-editor-conflict="" role="alert" className="sticky top-0 z-30 mx-auto mb-3 flex w-full max-w-canvas-prose flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface-floating px-3 py-2 text-small text-ink-default shadow-sm">
        <span className="font-semibold">Changed in Moss</span>
        <span className="text-ink-muted">{kept ? 'Your edits are not saved yet.' : 'This note changed on disk while you were editing. Your edits are not saved.'}</span>
        {view.conflict.preserved.length > 0 ? (
          <span className="w-full text-caption text-ink-muted">Moss&apos;s bytes were kept in {view.conflict.preserved.join(', ')}</span>
        ) : null}
        <span className="ml-auto flex gap-1.5">
          <button type="button" className={`${BUTTON} text-ink-default hover:bg-surface-hover`} onClick={() => void session.resolveConflict('reload')}>
            Reload
          </button>
          {kept ? null : (
            <button type="button" className={`${BUTTON} text-ink-default hover:bg-surface-hover`} onClick={() => setKept(true)}>
              Keep editing
            </button>
          )}
          <button type="button" className={`${BUTTON} bg-action-primary text-ink-inverse hover:bg-action-primary-hover`} onClick={() => void session.resolveConflict('overwrite')}>
            Overwrite
          </button>
        </span>
      </div>
    );
  }
  if (view.removed) {
    return (
      <div data-moss-editor-removed="" role="alert" className="sticky top-0 z-30 mx-auto mb-3 w-full max-w-canvas-prose rounded-lg border border-border-subtle bg-surface-floating px-3 py-2 text-small text-ink-default shadow-sm">
        This note was moved, deleted or can no longer be edited here. Unsaved edits are kept until you close it.
      </div>
    );
  }
  if (view.error) {
    return (
      <div data-moss-editor-error="" role="alert" className="sticky top-0 z-30 mx-auto mb-3 w-full max-w-canvas-prose rounded-lg border border-status-error-border bg-status-error-surface px-3 py-2 text-small text-status-error-text">
        Couldn&apos;t save: {view.error.message}. Your edits are kept and will be retried.
        {view.error.preserved.length > 0 ? <span className="block text-caption">Moss&apos;s bytes were kept in {view.error.preserved.join(', ')}</span> : null}
      </div>
    );
  }
  if (view.overwritten) {
    return (
      <div data-moss-editor-notice="overwritten" role="status" className="sticky top-0 z-30 mx-auto mb-3 flex w-full max-w-canvas-prose items-center gap-2 rounded-lg border border-border-subtle bg-surface-floating px-3 py-2 text-small text-ink-default shadow-sm">
        <span>Moss replaced your last save.</span>
        <span className="ml-auto flex gap-1.5">
          <button type="button" className={`${BUTTON} text-ink-default hover:bg-surface-hover`} onClick={() => session.dismissNotice()}>
            Dismiss
          </button>
          <button type="button" className={`${BUTTON} bg-action-primary text-ink-inverse hover:bg-action-primary-hover`} onClick={() => void session.restoreOverwritten()}>
            Restore
          </button>
        </span>
      </div>
    );
  }
  return null;
}

function EditorPane({ surface, session, noteId, onNavigateToNote, onShare }: {
  surface: FrameSurface;
  session: EditorSession;
  noteId: string;
  onNavigateToNote: (noteId: string, heading?: string | null) => void;
  onShare: (() => void) | null;
}): ReactNode {
  const state = useSyncExternalStore(surface.subscribe, surface.getState);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useCallback(
    (el: HTMLDivElement | null) => {
      surface.title = el;
      if (el && state.content && el.textContent === '') el.textContent = state.content.title;
    },
    [surface, state.content],
  );
  useEffect(() => {
    surface.handle = editorRef.current;
    surface.scroller = scrollerRef.current;
  });
  // Stable, so moss calls it once per editor: a new function each render re-ran attach and re-stored moss's
  // editor-state cache under the loaded content's key on every re-render.
  const onReady = useCallback(
    (editor: LexicalEditor) => {
      surface.handle = editorRef.current;
      surface.attach(editor);
    },
    [surface],
  );
  const focusBody = () => surface.editor?.focus();
  const { content, view } = state;
  // React events bubble through portals, so these capture handlers see input in moss's portalled popovers too.
  const swallow = (event: SyntheticEvent) => {
    if (!surface.getState().frozen) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col bg-surface-canvas"
      data-moss-editor-root=""
      inert={state.frozen}
      onFocusCapture={(event) => {
        surface.notePortal(event.target);
        if (surface.getState().frozen) {
          (event.target as HTMLElement).blur?.();
          return;
        }
        surface.focusTarget = event.target as HTMLElement;
      }}
      onKeyDownCapture={swallow}
      onKeyPressCapture={swallow}
      onKeyUpCapture={swallow}
      onBeforeInputCapture={swallow}
      onInputCapture={swallow}
      onCompositionStartCapture={swallow}
      onPasteCapture={swallow}
      onCutCapture={swallow}
      onDropCapture={swallow}
      onPointerDownCapture={(event) => {
        surface.notePortal(event.target);
        swallow(event);
      }}
      onMouseDownCapture={swallow}
      onPointerUpCapture={swallow}
      onMouseUpCapture={swallow}
      onClickCapture={swallow}
      onDoubleClickCapture={swallow}
      onContextMenuCapture={swallow}
      onTouchStartCapture={swallow}
      onSubmitCapture={swallow}
    >
      {onShare ? <ShareWithAgentBar onShare={onShare} /> : null}
      <CanvasArea className="relative min-w-0 flex-1" responsiveLayout innerClassName="flex w-full flex-col gap-1" contentClassName="mx-auto max-w-canvas-blocks" scrollContainerRef={scrollerRef}>
        <Banner view={view} session={session} />
        {view.status === 'notLoaded' ? (
          <div data-moss-editor-unavailable="" className="mx-auto w-full max-w-canvas-prose rounded-md border border-status-error-border bg-status-error-surface p-4 text-small text-status-error-text">
            This note can&apos;t be opened for editing.
          </div>
        ) : content ? (
          <div className="relative">
            <div className="relative mx-auto w-full max-w-canvas-prose">
              <div
                ref={titleRef}
                data-moss-editor-title=""
                contentEditable={state.editable}
                suppressContentEditableWarning
                role="textbox"
                aria-label="Note title"
                data-placeholder="What if…"
                className="mb-1 min-h-12 w-full text-left text-h1 font-semibold tracking-title text-ink-default outline-none empty:before:block empty:before:text-ink-faint/40 empty:before:content-[attr(data-placeholder)]"
                onBlur={surface.commitTitle}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault();
                    surface.commitTitle();
                    focusBody();
                  }
                  if (event.key === 'ArrowDown') focusBody();
                }}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData.getData('text/plain').replace(/\n/g, ' ');
                  const selection = window.getSelection();
                  if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    range.deleteContents();
                    range.insertNode(document.createTextNode(text));
                    range.collapse(false);
                  }
                }}
              />
            </div>
            <MarkdownEditor
              ref={editorRef}
              key={`${noteId}-${state.version}`}
              noteId={noteId}
              value={content.body}
              layoutMetadata={content.layoutMetadata}
              onChange={() => undefined}
              placeholder="Type '/' for commands"
              onReady={onReady}
              initialSerializedState={null}
              onNavigateToNote={onNavigateToNote}
              editorMountVersion={state.version}
            />
          </div>
        ) : (
          <div className="agent-skeleton agent-skeleton--content pt-4" data-moss-editor-loading="">
            {[100, 94, 88, 72].map((width, i) => (
              <div key={`editor-loading-${i}`} className="agent-skeleton-line" style={{ width: `${width}%` }} />
            ))}
          </div>
        )}
      </CanvasArea>
    </div>
  );
}

export function mountMossEditor(element: HTMLElement, options: MossEditorOptions): MossEditorHandle {
  installEditorElectronApi();
  installEditorHooks();
  const noteId = noteIdKey(options.noteId);
  const services = options.services ?? {};
  const store = createStore();
  const host = document.createElement('div');
  host.className = 'h-full';
  host.dataset.mossEditor = '';
  host.dataset.mossEditorStatus = 'loading';
  const theme: MossEditorTheme = options.theme ?? 'light';
  host.dataset.theme = theme;
  setEmbedTheme(noteId, theme);
  const activate = () => markActive(noteId);
  host.addEventListener('pointerdown', activate, true);
  element.append(host);

  const surface = new FrameSurface(store, noteId, host);
  const session = new EditorSession({ noteId: options.noteId, bridge: options.bridge, surface, onEvent: options.onEvent, restoreDraft: options.restoreDraft });
  surface.session = session;
  const unregister = registerEditor({ noteId, bridge: options.bridge, services, htmlFrameUrl: options.htmlFrameUrl ?? null, session });
  let live = true;
  const own: MossEditorNote = { id: noteId, title: '' };
  setNotes(store, [own]);
  void Promise.resolve(services.notes?.() ?? [])
    .then((notes) => {
      if (live) setNotes(store, [own, ...notes.filter((note) => note.id !== noteId)]);
    })
    .catch((error: unknown) => console.warn('[moss-editor] services.notes failed:', error));
  const stopNavigation = routeNavigation(store, noteId, services);
  const onNavigateToNote = (target: string, heading?: string | null) => {
    if (target !== noteId) services.navigate?.({ kind: 'note', noteId: target, heading: heading ?? null });
  };
  const selection = (): MossSelection | null => (live ? surface.selection() : null);
  const share = services.shareWithAgent;
  const onShare = share ? () => shareSelection(share, services, selection()) : null;

  const root = createRoot(host);
  root.render(
    <StrictMode>
      <Provider store={store}>
        <EditorPane surface={surface} session={session} noteId={noteId} onNavigateToNote={onNavigateToNote} onShare={onShare} />
      </Provider>
    </StrictMode>,
  );

  const teardown = () => {
    if (!live) return;
    live = false;
    root.unmount();
    surface.dispose();
    host.removeEventListener('pointerdown', activate, true);
    setEmbedTheme(noteId, null);
    host.remove();
    stopNavigation();
    unregister();
  };

  return {
    info: MOSS_EDITOR_INFO,
    noteId: options.noteId,
    get status() {
      return session.status;
    },
    get location() {
      return session.location;
    },
    ready: session.ready,
    setTheme(next: MossEditorTheme) {
      host.dataset.theme = next;
      setEmbedTheme(noteId, next);
    },
    flush: () => session.flush(),
    selection,
    reload: (reloadOptions) => session.reload(reloadOptions),
    async unmount(unmountOptions) {
      const result = await session.unmount(unmountOptions);
      if (result.kind === 'unmounted') teardown();
      return result;
    },
  };
}
