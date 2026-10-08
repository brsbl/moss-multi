// One mounted note's file lifecycle (contract.ts; docs/design/editor-embed.md §5-§7): the first read, autosave on
// desktop's timing, writes through the host bridge with the bytes the pipeline plans, the silent meta retry,
// conflicts ("Changed in Moss" with Reload, Keep editing and Overwrite), external changes, removal, flush, unmount,
// drafts and receipts, and assets. It knows nothing of React: the surface (mount.tsx) renders moss's editor and
// hands it snapshots of what moss's renderer would save.
import type {
  MossAssetPutResult,
  MossDraft,
  MossEditorBridge,
  MossEditorError,
  MossEditorEvent,
  MossEditorStatus,
  MossExternalChange,
  MossFlushFailure,
  MossFlushResult,
  MossMetaIntents,
  MossNoteFile,
  MossNoteLocation,
  MossNotEditableReason,
  MossReloadOptions,
  MossReloadResult,
  MossUnmountOptions,
  MossUnmountResult,
  MossWriteFailed,
  MossWriteResult,
} from './contract';
import { isMossAssetName, noteIdKey } from './host/moss-editor-host.js';
import { MOSS_EDITOR_API } from './info';
import {
  deriveRead,
  editorContentOfFiles,
  editorContentOfRead,
  planSave,
  readNote,
  type DiskNote,
  type EditorContent,
  type NoteRead,
  type PlannedFiles,
  type RendererSnapshot,
} from './desktop/pipeline';
import { buildImageFilename, getImageExtension } from './desktop/note-store.port';

export const TIMING = {
  idleSaveMs: 1500,
  maxUnsavedMs: 15000,
  periodicSaveMs: 1800000,
  externalChangeDebounceMs: 200,
  errorRetryMs: 5000,
  metaConflictRetries: 3,
  recentSaveGuardMs: 5000,
} as const;

export interface SessionView {
  status: MossEditorStatus;
  conflict: { cause: 'external' | 'refused'; preserved: readonly string[] } | null;
  /** "Moss replaced your last save", with Restore. */
  overwritten: boolean;
  error: { message: string; preserved: readonly string[] } | null;
  removed: string | null;
  /** Why the first read failed, while the status is `notLoaded`. */
  unavailable: MossEditorError['code'] | null;
}

export interface SessionSurface {
  /** Replaces the editor's content; `keepView` keeps selection and scroll where the new text allows. */
  load(content: EditorContent, options: { keepView: boolean }): void | Promise<void>;
  /** Commits drafts desktop commits before saving (a focused title, decorator drafts); edits it causes are reported. */
  commit?(): Promise<void> | void;
  /** What moss's renderer would save now. */
  snapshot(): RendererSnapshot | null;
  setEditable(editable: boolean): void;
  /** Freezes every input, comment UI included, while unmount waits for its final write. */
  freeze?(frozen: boolean): void;
  view(view: SessionView): void;
  /** meta.json's comment colors changed on disk: each color the user has not changed takes `next`'s. */
  adoptCommentColors?(previous: Record<string, number> | undefined, next: Record<string, number> | undefined): void;
}

export interface SessionOptions {
  noteId: string;
  bridge: MossEditorBridge;
  surface: SessionSurface;
  onEvent?: (event: MossEditorEvent) => void;
  restoreDraft?: MossDraft;
}

export interface AssetInput {
  data: Blob;
  filename?: string;
  mimeType: string;
  purpose: 'body' | 'comment';
}

const KNOWN_WRITE_KINDS = new Set(['saved', 'conflict', 'failed', 'notFound', 'notEditable']);
const EMPTY_INTENTS: MossMetaIntents = { frontmatterMetaUpdates: {}, commentColors: {} };

const sameColors = (a: Record<string, number> | undefined, b: Record<string, number> | undefined) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

function editorError(code: MossEditorError['code'], message: string, extra: { reason?: MossNotEditableReason; cause?: unknown } = {}): MossEditorError {
  const error = new Error(message, extra.cause === undefined ? undefined : { cause: extra.cause }) as Error & {
    code: MossEditorError['code'];
    reason?: MossNotEditableReason;
  };
  error.name = 'MossEditorError';
  error.code = code;
  if (extra.reason) error.reason = extra.reason;
  return error as MossEditorError;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The files a write touched: the ops plus the markdown move a rename implies. */
const touched = (ops: readonly { file: MossNoteFile }[]): MossNoteFile[] => ops.map((op) => op.file);

export class EditorSession {
  readonly noteId: string;
  private readonly bridge: MossEditorBridge;
  private readonly surface: SessionSurface;
  private readonly onEvent?: (event: MossEditorEvent) => void;
  private readonly restore?: MossDraft;

  status: MossEditorStatus = 'loading';
  location: MossNoteLocation | null = null;
  readonly ready: Promise<void>;

  private read: NoteRead | null = null;
  /** Bumped by every edit; `savedRevision` is the last one known to be on disk. */
  private revision = 0;
  /** Counts in-place loads, so one a later load overtook neither re-enables editing nor reports. */
  private loads = 0;
  /** In-place loads under way. */
  private loadingInPlace = 0;
  private savedRevision = 0;
  private unsavedStartedAt: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopWatch: (() => void) | null = null;
  private conflict: SessionView['conflict'] = null;
  private failure: { error: unknown; failure: MossWriteFailed | null } | null = null;
  private removedReason: 'notFound' | MossNotEditableReason | null = null;
  private loadFailure: MossEditorError['code'] | null = null;
  /** After a failed or lost write the disk state is unknown: re-read and adopt the editor's own bytes. */
  private needsReread = false;
  /** The content files of the last write sent, for adopting the editor's own state. */
  private lastSent: PlannedFiles | null = null;
  private lastReceipt: { draft: MossDraft; revision: number } | null = null;
  private lastSave: { at: number; receipt: MossDraft } | null = null;
  private overwrittenDraft: MossDraft | null = null;
  /** Intents to write even with unchanged content (a restored draft's meta inputs). */
  private forceWrite = false;
  private intentsOverride: MossMetaIntents | null = null;
  private flushes = new Map<number, Promise<MossFlushResult>>();
  private unmounting: Promise<MossUnmountResult> | null = null;
  private unmounted: MossUnmountResult | null = null;
  private abandoned = false;
  private lifecycle: (() => void) | null = null;
  /** A stale restored draft's own base, kept for every export until the user reloads or overwrites. */
  private draftBase: Pick<MossDraft, 'baseVersion' | 'companions'> | null = null;

  constructor(options: SessionOptions) {
    this.noteId = options.noteId;
    this.bridge = options.bridge;
    this.surface = options.surface;
    this.onEvent = options.onEvent;
    this.restore = options.restoreDraft;
    this.surface.setEditable(false);
    this.ready = this.start();
    // ready's rejection is the host's to handle; it must not surface as unhandled here.
    this.ready.catch(() => undefined);
  }

  // ---- events and view ----------------------------------------------------------------------------------------

  private emit(event: MossEditorEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      console.error('[moss-editor] onEvent threw:', error);
    }
  }

  private setStatus(status: MossEditorStatus): void {
    this.status = status;
    this.render();
  }

  private render(): void {
    this.surface.view({
      status: this.status,
      conflict: this.status === 'conflict' ? this.conflict : null,
      overwritten: this.overwrittenDraft !== null,
      error: this.status === 'error' && this.failure ? { message: messageOf(this.failure.error), preserved: this.failure.failure?.preserved ?? [] } : null,
      removed: this.status === 'removed' ? this.removedReason : null,
      unavailable: this.status === 'notLoaded' ? this.loadFailure : null,
    });
  }

  private get dirty(): boolean {
    return this.revision !== this.savedRevision || this.forceWrite;
  }

  // ---- loading ------------------------------------------------------------------------------------------------

  private async readCompanion(relativePath: string) {
    const result = await this.bridge.readCompanion(this.noteId, relativePath);
    return { text: result.kind === 'file' ? result.text : null, version: result.version };
  }

  private async readDisk(): Promise<{ kind: 'note'; read: NoteRead } | { kind: 'notFound' } | { kind: 'notEditable'; reason: MossNotEditableReason }> {
    const result = await this.bridge.read(this.noteId);
    if (result.kind !== 'note') return result;
    const disk: DiskNote = { files: result.files, location: result.location, version: result.version, metaVersion: result.metaVersion };
    const read = await readNote(disk, (path) => this.readCompanion(path));
    if (read.migrationError) {
      this.emit({ kind: 'error', noteId: this.noteId, status: this.status === 'loading' ? 'notLoaded' : 'error', op: 'readCompanion', message: messageOf(read.migrationError), error: read.migrationError, failure: null, willRetry: false });
    }
    return { kind: 'note', read };
  }

  private async start(): Promise<void> {
    const fail = (error: MossEditorError): never => {
      this.status = 'notLoaded';
      this.loadFailure = error.code;
      this.render();
      this.emit({ kind: 'error', noteId: this.noteId, status: 'notLoaded', op: 'read', message: error.message, error, failure: null, willRetry: false });
      throw error;
    };
    // A host of another API (an API 1 host of editor 0.2.0 or earlier) gets a typed refusal before any bridge call.
    if (this.bridge.api !== MOSS_EDITOR_API) fail(editorError('apiMismatch', `bridge.api is ${String(this.bridge.api)}; this editor implements API ${MOSS_EDITOR_API}`));
    let result;
    try {
      result = await this.readDisk();
    } catch (cause) {
      if (this.abandoned) throw editorError('unmounted', 'unmounted before the note was read');
      return fail(editorError('readFailed', `reading the note failed: ${messageOf(cause)}`, { cause }));
    }
    if (this.abandoned) throw editorError('unmounted', 'unmounted before the note was read');
    if (result.kind === 'notFound') return fail(editorError('notFound', 'the note was not found'));
    if (result.kind === 'notEditable') return fail(editorError('notEditable', `the note is not editable (${result.reason})`, { reason: result.reason }));
    if (result.read.metaTitle === undefined) return fail(editorError('notEditable', 'meta.json is not a note Moss can read', { reason: 'unadopted' }));

    this.read = result.read;
    this.location = result.read.disk.location;
    let content = editorContentOfRead(result.read);
    let status: MossEditorStatus = 'clean';
    const draft = this.restore;
    if (draft && noteIdKey(draft.noteId) !== noteIdKey(this.noteId)) {
      this.emit({ kind: 'error', noteId: this.noteId, status: 'error', op: 'read', message: 'restoreDraft names another note; it was ignored', error: null, failure: null, willRetry: false });
    } else if (draft) {
      const disk = result.read.disk.files;
      const onDisk = disk.markdown === draft.files.markdown && disk.comments === draft.files.comments && disk.layout === draft.files.layout;
      const companionsMatch = await this.companionsMatch(draft);
      if (onDisk) {
        if (this.intentsDiffer(draft.intents)) {
          this.intentsOverride = draft.intents;
          this.forceWrite = true;
          status = 'dirty';
          // The live comments carry the receipt's colors, which the save takes over the disk's.
          content = { ...content, commentColors: draft.intents.commentColors };
        }
      } else {
        content = editorContentOfFiles(draft.files, draft.intents.commentColors, result.read.metaTitle);
        this.intentsOverride = draft.intents;
        if (draft.baseVersion === result.read.disk.version && companionsMatch) {
          status = 'dirty';
        } else {
          status = 'conflict';
          this.conflict = { cause: 'external', preserved: [] };
          this.draftBase = { baseVersion: draft.baseVersion, companions: draft.companions };
        }
        this.revision += 1;
      }
    }
    await this.surface.load(content, { keepView: false });
    if (this.abandoned) throw editorError('unmounted', 'unmounted before the note was shown');
    this.stopWatch = this.bridge.watch(this.noteId, (change) => this.onExternal(change));
    this.periodic = setInterval(() => {
      if (this.dirty && this.status === 'dirty') void this.save();
    }, TIMING.periodicSaveMs);
    this.installLifecycle();
    this.surface.setEditable(true);
    this.setStatus(status);
    if (status === 'dirty') {
      this.emit({ kind: 'dirty', noteId: this.noteId, status: 'dirty' });
      this.schedule();
    }
    if (status === 'conflict') this.emit({ kind: 'conflict', noteId: this.noteId, status: 'conflict', cause: 'external', preserved: [] });
  }

  private async companionsMatch(draft: MossDraft): Promise<boolean> {
    for (const companion of draft.companions) {
      try {
        if ((await this.bridge.readCompanion(this.noteId, companion.relativePath)).version !== companion.version) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private intentsDiffer(intents: MossMetaIntents): boolean {
    if (Object.keys(intents.frontmatterMetaUpdates).length > 0) return true;
    const colors = this.read?.commentColors ?? {};
    return JSON.stringify(Object.entries(colors).sort()) !== JSON.stringify(Object.entries(intents.commentColors).sort());
  }

  private installLifecycle(): void {
    if (typeof window === 'undefined') return;
    const backstop = () => void this.flush();
    const hidden = () => {
      if (document.visibilityState === 'hidden') backstop();
    };
    window.addEventListener('pagehide', backstop);
    window.addEventListener('beforeunload', backstop);
    document.addEventListener('visibilitychange', hidden);
    this.lifecycle = () => {
      window.removeEventListener('pagehide', backstop);
      window.removeEventListener('beforeunload', backstop);
      document.removeEventListener('visibilitychange', hidden);
    };
  }

  // ---- edits and autosave -------------------------------------------------------------------------------------

  /** Called by the surface on every edit: body, title, comments, properties. */
  markEdited(): void {
    if (this.status === 'loading' || this.status === 'notLoaded' || this.status === 'unmounted') return;
    // The baseline already is the version an in-place load is showing; an edit to the content it replaces is not
    // saved against it.
    if (this.loadingInPlace > 0) return;
    const wasDirty = this.dirty;
    this.revision += 1;
    if (this.status === 'removed') return;
    if (this.status === 'conflict') return;
    if (!wasDirty && this.status === 'clean') {
      this.setStatus('dirty');
      this.emit({ kind: 'dirty', noteId: this.noteId, status: 'dirty' });
    }
    this.schedule();
  }

  /** CanvasAreaContent.tsx:1258-1281: restart the idle timer, or save at once once 15 s have gone unsaved. */
  private schedule(): void {
    const now = Date.now();
    if (this.unsavedStartedAt === null) this.unsavedStartedAt = now;
    this.clearIdle();
    if (now - this.unsavedStartedAt >= TIMING.maxUnsavedMs) {
      this.unsavedStartedAt = now;
      void this.save();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.save();
    }, TIMING.idleSaveMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private snapshot(): RendererSnapshot | null {
    const snapshot = this.surface.snapshot();
    if (!snapshot) return null;
    return this.intentsOverride ? { ...snapshot, intents: { ...snapshot.intents, ...this.mergeIntents(snapshot.intents) } } : snapshot;
  }

  /** A restored draft's provenance updates ride along until they are written; colors follow the live comments. */
  private mergeIntents(live: MossMetaIntents): MossMetaIntents {
    const override = this.intentsOverride ?? EMPTY_INTENTS;
    return { frontmatterMetaUpdates: { ...override.frontmatterMetaUpdates, ...live.frontmatterMetaUpdates }, commentColors: live.commentColors };
  }

  /** Saves the editor's current revision, after any write in flight. */
  save(options: { force?: boolean } = {}): Promise<void> {
    const run = async () => {
      if (this.inFlight) await this.inFlight.catch(() => undefined);
      await this.writeOnce(options);
    };
    const promise = run().finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  private async writeOnce(options: { force?: boolean }): Promise<void> {
    if (!this.read) return;
    if (this.status === 'conflict' && !options.force) return;
    // A stale restored draft writes only after an explicit Overwrite, which clears draftBase.
    if (this.draftBase && !options.force) return;
    if (this.status === 'removed' || this.status === 'unmounted' || this.status === 'notLoaded') return;
    this.clearIdle();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.dirty && !options.force) {
      this.unsavedStartedAt = null;
      return;
    }
    let snapshot = this.snapshot();
    if (!snapshot) return;
    const revision = this.revision;

    if (this.needsReread) {
      const settled = await this.adoptAfterUnknown();
      if (!settled) return;
    }

    let metaRetries = 0;
    for (;;) {
      const read: NoteRead = this.read!;
      const plan = planSave(read, snapshot, { now: nowSeconds(), force: options.force || this.forceWrite });
      if (plan.kind === 'skip') {
        this.markSaved(revision);
        return;
      }
      if (this.status !== 'saving') {
        this.setStatus('saving');
        this.emit({ kind: 'saving', noteId: this.noteId, status: 'saving' });
      }
      this.lastSent = plan.files;
      let result: MossWriteResult;
      try {
        result = await this.bridge.write(this.noteId, plan.write);
      } catch (error) {
        this.needsReread = true;
        this.fail(error, null);
        return;
      }
      if (!KNOWN_WRITE_KINDS.has(result.kind)) {
        this.needsReread = true;
        this.fail(new Error(`bridge.write returned an unknown kind ${JSON.stringify((result as { kind: unknown }).kind)}`), null);
        return;
      }
      if (result.kind === 'saved') {
        this.afterSaved(read, plan.files, plan.write.ops, result.location.folderName !== read.disk.location.folderName, result, snapshot.intents, revision);
        return;
      }
      if (result.kind === 'notFound' || result.kind === 'notEditable') {
        this.remove(result.kind === 'notFound' ? 'notFound' : result.reason);
        return;
      }
      if (result.kind === 'failed') {
        this.needsReread = true;
        this.location = result.location;
        this.fail(new Error(result.message), result);
        return;
      }
      // conflict
      this.location = result.location;
      if (result.reason === 'meta') {
        metaRetries += 1;
        const fresh = await this.tryRead();
        if (!fresh) return;
        if (fresh.disk.version !== read.disk.version) {
          if (!this.adoptIfOwn(fresh)) return this.enterConflict('refused', []);
          continue;
        }
        if (this.refreshMeta(fresh)) snapshot = this.snapshot() ?? snapshot;
        if (metaRetries > TIMING.metaConflictRetries) {
          this.fail(new Error('meta.json kept changing; the save will be retried'), null);
          return;
        }
        continue;
      }
      if (result.reason === 'content') {
        const fresh = await this.tryRead();
        if (!fresh) return;
        if (this.adoptIfOwn(fresh)) continue;
        return this.enterConflict('refused', []);
      }
      return this.enterConflict('refused', result.preserved);
    }
  }

  private markSaved(revision: number): void {
    this.savedRevision = Math.max(this.savedRevision, revision);
    this.forceWrite = false;
    if (!this.dirty) {
      this.unsavedStartedAt = null;
      if (this.status !== 'conflict' && this.status !== 'removed') this.setStatus('clean');
    }
  }

  private afterSaved(
    base: NoteRead,
    files: PlannedFiles,
    ops: readonly { file: MossNoteFile }[],
    renamed: boolean,
    result: Extract<MossWriteResult, { kind: 'saved' }>,
    intents: MossMetaIntents,
    revision: number,
  ): void {
    const disk: DiskNote = { files: { ...files }, location: result.location, version: result.version, metaVersion: result.metaVersion };
    this.read = deriveRead(disk, files.markdown, []);
    this.location = result.location;
    this.failure = null;
    this.needsReread = false;
    this.intentsOverride = null;
    const receipt: MossDraft = {
      noteId: this.noteId,
      baseVersion: base.disk.version,
      companions: base.companions,
      files: { markdown: files.markdown, comments: files.comments, layout: files.layout },
      intents,
      at: Date.now(),
    };
    this.lastReceipt = { draft: receipt, revision };
    this.lastSave = { at: Date.now(), receipt };
    this.savedRevision = Math.max(this.savedRevision, revision);
    this.forceWrite = false;
    const status = this.dirty ? 'dirty' : 'clean';
    if (status === 'clean') this.unsavedStartedAt = null;
    this.setStatus(status);
    this.emit({ kind: 'saved', noteId: this.noteId, status, version: result.version, files: touched(ops), location: result.location, renamed, receipt, at: Date.now() });
    if (status === 'dirty') this.schedule();
  }

  private async tryRead(): Promise<NoteRead | null> {
    try {
      const fresh = await this.readDisk();
      if (fresh.kind !== 'note') {
        this.remove(fresh.kind === 'notFound' ? 'notFound' : fresh.reason);
        return null;
      }
      return fresh.read;
    } catch (error) {
      if (this.status === 'conflict') {
        // The conflict stays unresolved: only the user's next choice (Reload, Overwrite) may move it. The event's
        // status is 'error' as the contract types it (as for asset errors); the editor's own status stays 'conflict'.
        this.emit({ kind: 'error', noteId: this.noteId, status: 'error', op: 'read', message: messageOf(error), error, failure: null, willRetry: false });
        return null;
      }
      this.needsReread = true;
      this.fail(error, null);
      return null;
    }
  }

  /**
   * The editor rule on MossNoteWrite: when each content file on disk equals either its base bytes or the bytes
   * this editor last sent, the disk is the editor's own state; adopt it as the base.
   */
  private adoptIfOwn(fresh: NoteRead): boolean {
    const base = this.read!.disk.files;
    const sent = this.lastSent;
    const disk = fresh.disk.files;
    const own = (file: 'markdown' | 'comments' | 'layout') => disk[file] === base[file] || (sent !== null && disk[file] === sent[file]);
    if (!own('markdown') || !own('comments') || !own('layout')) return false;
    this.read = fresh;
    this.location = fresh.disk.location;
    return true;
  }

  private async adoptAfterUnknown(): Promise<boolean> {
    const fresh = await this.tryRead();
    if (!fresh) return false;
    if (fresh.disk.version === this.read!.disk.version) {
      this.refreshMeta(fresh);
      this.needsReread = false;
      return true;
    }
    if (this.adoptIfOwn(fresh)) {
      this.needsReread = false;
      return true;
    }
    this.needsReread = false;
    this.enterConflict('refused', []);
    return false;
  }

  /**
   * meta.json or the location changed, the content files did not: take the new meta baseline, and hand changed
   * comment colors to the surface so the next save does not write the old ones back. True when colors changed.
   */
  private refreshMeta(fresh: NoteRead): boolean {
    const read = this.read!;
    this.read = {
      ...read,
      disk: { ...read.disk, files: { ...read.disk.files, meta: fresh.disk.files.meta }, metaVersion: fresh.disk.metaVersion, location: fresh.disk.location },
      commentColors: fresh.commentColors,
      metaTitle: fresh.metaTitle,
    };
    this.location = fresh.disk.location;
    if (sameColors(read.commentColors, fresh.commentColors)) return false;
    this.surface.adoptCommentColors?.(read.commentColors, fresh.commentColors);
    return true;
  }

  private fail(error: unknown, failure: MossWriteFailed | null): void {
    this.failure = { error, failure };
    this.setStatus('error');
    this.emit({ kind: 'error', noteId: this.noteId, status: 'error', op: 'write', message: messageOf(error), error, failure, willRetry: true });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.save();
    }, TIMING.errorRetryMs);
  }

  private enterConflict(cause: 'external' | 'refused', preserved: readonly string[]): void {
    this.clearIdle();
    this.conflict = { cause, preserved };
    this.setStatus('conflict');
    this.emit({ kind: 'conflict', noteId: this.noteId, status: 'conflict', cause, preserved });
  }

  private remove(reason: 'notFound' | MossNotEditableReason): void {
    if (this.status === 'removed' || this.status === 'unmounted') return;
    this.clearIdle();
    this.removedReason = reason;
    const hadUnsavedEdits = this.dirty;
    this.surface.setEditable(false);
    this.setStatus('removed');
    this.emit({ kind: 'removed', noteId: this.noteId, status: 'removed', reason, hadUnsavedEdits });
  }

  // ---- external changes ---------------------------------------------------------------------------------------

  private onExternal(change: MossExternalChange): void {
    if (this.status === 'unmounted') return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.handleExternal(change);
    }, TIMING.externalChangeDebounceMs);
  }

  private async handleExternal(change: MossExternalChange): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    if (!this.read || this.status === 'unmounted' || this.status === 'removed') return;
    if (change.kind === 'removed') {
      this.remove(change.reason);
      return;
    }
    if (change.version === this.read.disk.version && change.metaVersion === this.read.disk.metaVersion) return;
    const base = this.read;
    const fresh = await this.tryRead();
    if (!fresh) return;
    // A save that landed while the disk was read makes this read older than the editor: read again.
    if (await this.superseded(base)) return this.handleExternal(change);
    if (fresh.disk.version === this.read.disk.version) {
      // meta.json or the location only: refresh the meta baseline.
      this.refreshMeta(fresh);
      return;
    }
    // A focused title or a decorator draft is an edit not yet reported: commit it so it counts below.
    await this.surface.commit?.();
    const after = this.status as MossEditorStatus; // the commit awaited, so an unmount or removal may have landed
    if (after === 'unmounted' || after === 'removed') return;
    if (!this.dirty && (await this.superseded(base))) return this.handleExternal(change);
    if (this.dirty || this.status === 'conflict') {
      if (this.status !== 'conflict') this.enterConflict('external', []);
      return;
    }
    const recent = this.lastSave && Date.now() - this.lastSave.at < TIMING.recentSaveGuardMs ? this.lastSave.receipt : null;
    await this.applyRead(fresh, 'external', recent);
  }

  /** Whether the editor's baseline moved (a save landed) since `base`, after any write still in flight. */
  private async superseded(base: NoteRead | null): Promise<boolean> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    return this.read !== base && this.status !== 'unmounted' && this.status !== 'removed';
  }

  private async applyRead(fresh: NoteRead, cause: 'external' | 'host' | 'conflict', overwrittenSave: MossDraft | null): Promise<void> {
    // A read that finishes after teardown changes nothing.
    if (this.status === 'unmounted') return;
    this.read = fresh;
    this.draftBase = null;
    this.location = fresh.disk.location;
    this.intentsOverride = null;
    this.forceWrite = false;
    this.failure = null;
    this.conflict = null;
    this.savedRevision = this.revision;
    this.unsavedStartedAt = null;
    this.clearIdle();
    this.overwrittenDraft = overwrittenSave;
    if (!(await this.loadInPlace(editorContentOfRead(fresh)))) return;
    if ((this.status as MossEditorStatus) === 'unmounted') return;
    // The editor's own change listener may have counted the load as an edit; nothing else could, as it was read-only.
    this.savedRevision = this.revision;
    this.setStatus('clean');
    this.emit({ kind: 'reloaded', noteId: this.noteId, status: 'clean', version: fresh.disk.version, cause, overwrittenSave });
  }

  /**
   * Loads in place with the editor read-only, so nothing the user types can land while the load settles. False when
   * a later load began while this one waited (on a node view's chunk): that load owns the editor and reports.
   */
  private async loadInPlace(content: EditorContent): Promise<boolean> {
    const generation = ++this.loads;
    this.surface.setEditable(false);
    this.loadingInPlace += 1;
    try {
      await this.surface.load(content, { keepView: true });
    } finally {
      this.loadingInPlace -= 1;
      if (generation === this.loads && this.status !== 'removed' && this.status !== 'unmounted') this.surface.setEditable(true);
    }
    return generation === this.loads;
  }

  // ---- the user's choices -------------------------------------------------------------------------------------

  async resolveConflict(choice: 'reload' | 'keep' | 'overwrite'): Promise<void> {
    if (this.status !== 'conflict') return;
    if (choice === 'keep') {
      this.render();
      return;
    }
    const fresh = await this.tryRead();
    if (!fresh || (this.status as MossEditorStatus) !== 'conflict') return;
    if (choice === 'reload') {
      await this.applyRead(fresh, 'conflict', null);
      if ((this.status as MossEditorStatus) === 'unmounted') return;
      this.emit({ kind: 'conflictResolved', noteId: this.noteId, status: 'clean', resolution: 'reloaded' });
      return;
    }
    // Overwrite: the local version, saved on top of what is on disk now.
    this.read = fresh;
    this.draftBase = null;
    this.location = fresh.disk.location;
    this.conflict = null;
    this.setStatus('saving');
    this.emit({ kind: 'conflictResolved', noteId: this.noteId, status: 'saving', resolution: 'overwritten' });
    await this.save({ force: true });
  }

  /** "Moss replaced your last save" → Restore: re-apply the receipt on the new version. */
  async restoreOverwritten(): Promise<void> {
    const draft = this.overwrittenDraft;
    this.overwrittenDraft = null;
    if (!draft || !this.read) return this.render();
    const content = editorContentOfFiles(draft.files, draft.intents.commentColors, this.read.metaTitle);
    if (!(await this.loadInPlace(content))) return;
    this.intentsOverride = draft.intents;
    this.revision += 1;
    this.setStatus('dirty');
    this.emit({ kind: 'dirty', noteId: this.noteId, status: 'dirty' });
    this.schedule();
  }

  dismissNotice(): void {
    this.overwrittenDraft = null;
    this.render();
  }

  // ---- drafts, flush, reload, unmount -------------------------------------------------------------------------

  /** The unsaved edits as a draft; meta.json rides as intents. */
  draft(): MossDraft {
    const read = this.read!;
    const snapshot = this.snapshot();
    let files = { markdown: read.disk.files.markdown, comments: read.disk.files.comments, layout: read.disk.files.layout };
    let intents = this.intentsOverride ?? EMPTY_INTENTS;
    if (snapshot) {
      const plan = planSave(read, snapshot, { now: nowSeconds(), force: true });
      if (plan.kind === 'write') files = { markdown: plan.files.markdown, comments: plan.files.comments, layout: plan.files.layout };
      intents = snapshot.intents;
    }
    const base = this.draftBase ?? { baseVersion: read.disk.version, companions: read.companions };
    return { noteId: this.noteId, baseVersion: base.baseVersion, companions: base.companions, files, intents, at: Date.now() };
  }

  private failureResult(): MossFlushFailure {
    if (this.status === 'conflict') return { kind: 'conflict', draft: this.draft(), preserved: this.conflict?.preserved ?? [] };
    if (this.status === 'removed') return { kind: 'removed', reason: this.removedReason ?? 'notFound', draft: this.draft() };
    return { kind: 'error', error: this.failure?.error ?? new Error('the edits are not saved'), failure: this.failure?.failure ?? null, draft: this.draft() };
  }

  async flush(): Promise<MossFlushResult> {
    try {
      await this.ready;
    } catch {
      return { kind: 'notLoaded' };
    }
    if (this.status === 'unmounted') return this.unmounted?.flush ?? { kind: 'notLoaded' };
    // Commit drafts first so the revision covers them; an edit the commit reports bumps it.
    await this.surface.commit?.();
    const revision = this.revision;
    const shared = this.flushes.get(revision);
    if (shared) return shared;
    const promise = this.flushAt(revision).finally(() => this.flushes.delete(revision));
    this.flushes.set(revision, promise);
    return promise;
  }

  private async flushAt(revision: number): Promise<MossFlushResult> {
    if (this.status === 'conflict' || this.status === 'removed') return this.failureResult();
    const pendingBefore = revision !== this.savedRevision || this.forceWrite;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    if (this.savedRevision < revision || this.forceWrite) await this.save();
    if (this.savedRevision >= revision && !this.forceWrite) {
      if (this.lastReceipt && this.lastReceipt.revision >= revision && pendingBefore) {
        return { kind: 'saved', version: this.read!.disk.version, receipt: this.lastReceipt.draft };
      }
      return { kind: 'clean', version: this.read!.disk.version };
    }
    return this.failureResult();
  }

  async reload(options: MossReloadOptions = {}): Promise<MossReloadResult> {
    try {
      await this.ready;
    } catch {
      return { kind: 'notLoaded' };
    }
    const refuse = async () => {
      if (options.discardUnsaved) return false;
      await this.surface.commit?.();
      return this.dirty;
    };
    if (await refuse()) return { kind: 'refused', reason: 'dirty' };
    try {
      let read: NoteRead | null = null;
      for (let attempt = 0; read === null; attempt += 1) {
        const base = this.read;
        const fresh = await this.readDisk();
        if (fresh.kind !== 'note') {
          const reason = fresh.kind === 'notFound' ? 'notFound' : fresh.reason;
          this.remove(reason);
          return { kind: 'removed', reason };
        }
        // An edit typed while the disk was read is kept: the reload is refused instead.
        if (await refuse()) return { kind: 'refused', reason: 'dirty' };
        // A save that landed meanwhile makes this read older than the editor: read again.
        if (!(await this.superseded(base))) read = fresh.read;
        else if (attempt >= 3) return { kind: 'error', error: new Error('the note kept changing while it was read') };
      }
      if (this.status === 'unmounted') return { kind: 'error', error: editorError('unmounted', 'the editor was unmounted while the note was read') };
      const wasConflict = this.status === 'conflict';
      await this.applyRead(read, 'host', null);
      if ((this.status as MossEditorStatus) === 'unmounted') return { kind: 'error', error: editorError('unmounted', 'the editor was unmounted while the note loaded') };
      if (wasConflict) this.emit({ kind: 'conflictResolved', noteId: this.noteId, status: 'clean', resolution: 'reloaded' });
      return { kind: 'reloaded', version: read.disk.version };
    } catch (error) {
      return { kind: 'error', error };
    }
  }

  unmount(options: MossUnmountOptions = {}): Promise<MossUnmountResult> {
    if (this.unmounted) return Promise.resolve(this.unmounted);
    if (this.unmounting) return this.unmounting;
    this.unmounting = this.unmountOnce(options).finally(() => {
      this.unmounting = null;
    });
    return this.unmounting;
  }

  private async unmountOnce(options: MossUnmountOptions): Promise<MossUnmountResult> {
    if (this.status === 'loading') {
      this.abandoned = true;
      return this.teardown({ kind: 'notLoaded' });
    }
    this.surface.setEditable(false);
    this.surface.freeze?.(true);
    let flush = await this.flush();
    // An edit that landed while the final write was pending is flushed too; teardown leaves nothing unsaved.
    for (let round = 0; (flush.kind === 'clean' || flush.kind === 'saved') && this.dirty && round < 3; round += 1) {
      const next = await this.flush();
      flush = next.kind === 'clean' && flush.kind === 'saved' ? flush : next;
    }
    if ((flush.kind === 'clean' || flush.kind === 'saved') && this.dirty) flush = this.failureResult();
    if (flush.kind === 'clean' || flush.kind === 'saved' || flush.kind === 'notLoaded' || options.discardUnsaved) return this.teardown(flush);
    this.surface.freeze?.(false);
    if (this.status !== 'removed') this.surface.setEditable(true);
    return { kind: 'kept', flush };
  }

  private teardown(flush: MossFlushResult): MossUnmountResult {
    this.clearIdle();
    for (const timer of [this.retryTimer, this.watchTimer]) if (timer) clearTimeout(timer);
    if (this.periodic) clearInterval(this.periodic);
    this.stopWatch?.();
    this.lifecycle?.();
    this.status = 'unmounted';
    this.unmounted = { kind: 'unmounted', flush };
    return this.unmounted;
  }

  // ---- assets -------------------------------------------------------------------------------------------------

  /**
   * Stores media through the host under the name desktop's `images.save` would give it (`buildImageFilename`),
   * from the base `image` when that name fails `isMossAssetName`, and once more on `exists`.
   */
  async putAsset(input: AssetInput): Promise<{ relativePath: string; absolutePath: string; filename: string }> {
    const extension = getImageExtension(input.mimeType);
    const nameFor = () => {
      const named = buildImageFilename(input.filename, extension, Date.now(), crypto.randomUUID());
      return isMossAssetName(named) ? named : buildImageFilename(undefined, extension, Date.now(), crypto.randomUUID());
    };
    let result: MossAssetPutResult = { kind: 'exists' };
    let name = '';
    for (let attempt = 0; attempt < 2 && result.kind === 'exists'; attempt += 1) {
      name = nameFor();
      result = await this.bridge.assets.put(this.noteId, { name, data: input.data, mimeType: input.mimeType, purpose: input.purpose });
    }
    return this.stored('assetPut', result, name);
  }

  async copyAsset(sourceNoteId: string, sourceRef: `assets/${string}`, filename: string): Promise<{ relativePath: string; absolutePath: string; filename: string }> {
    const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase() || '.png';
    let result: MossAssetPutResult = { kind: 'exists' };
    let name = '';
    for (let attempt = 0; attempt < 2 && result.kind === 'exists'; attempt += 1) {
      const named = buildImageFilename(filename, extension, Date.now(), crypto.randomUUID());
      name = isMossAssetName(named) ? named : buildImageFilename(undefined, extension, Date.now(), crypto.randomUUID());
      result = await this.bridge.assets.copyFromNote(this.noteId, { sourceNoteId, sourceRef, name });
    }
    return this.stored('assetCopy', result, name);
  }

  private stored(op: 'assetPut' | 'assetCopy', result: MossAssetPutResult, name: string) {
    if (result.kind === 'stored') {
      const absolutePath = this.bridge.assets.url(this.noteId, result.ref, /\.(mp4|webm|mov)$/i.test(result.ref) ? 'video' : 'image') ?? result.ref;
      return { relativePath: result.ref, absolutePath, filename: result.ref.slice(result.ref.lastIndexOf('/') + 1) || name };
    }
    const message =
      result.kind === 'refused'
        ? result.reason === 'tooLarge'
          ? `That file is too large${result.maxBytes ? ` (the limit is ${Math.round(result.maxBytes / 1_000_000)} MB)` : ''}.`
          : result.reason === 'type'
            ? 'That file type cannot be added to a note.'
            : result.reason === 'noSpace'
              ? 'There is no space left to store that file.'
              : result.reason === 'sourceNotOpen'
                ? 'That file comes from a note that is not open, so it was not copied.'
                : 'That file name cannot be stored.'
        : result.kind === 'exists'
          ? 'A file with that name already exists.'
          : 'This note is no longer available, so the file was not added.';
    const error = new Error(message);
    this.emit({ kind: 'error', noteId: this.noteId, status: 'error', op, message, error, failure: null, willRetry: false });
    throw error;
  }
}
