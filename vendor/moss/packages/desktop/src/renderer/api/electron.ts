// ported-from: packages/desktop/src/renderer/api/electron.ts @ 762abb777
import type {
  ElectronAPI,
  GetByIdOptions,
  GetContentOptions,
  HtmlPreviewFailedEntry,
  HtmlPreviewMaterializedEntry,
  VideoThumbnailMaterializedEntry
} from '../../types/electron-api';
import type { DerivedPreviewResult } from '../../common/derived-preview';

export interface RequestState<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
}

export interface ElectronInvoker<Args extends unknown[], Result> {
  invoke: (...args: Args) => Promise<Result>;
  getState: () => RequestState<Result>;
  reset: () => void;
}

const defaultState = <T>(): RequestState<T> => ({
  data: null,
  error: null,
  isLoading: false
});

const ensureElectronAPI = (): ElectronAPI => {
  if (typeof window === 'undefined') {
    throw new Error('Electron API is unavailable in this environment');
  }

  if (!window.electronAPI) {
    throw new Error('Electron API not found on window');
  }

  return window.electronAPI;
};

function createInvoker<Args extends unknown[], Result>(
  call: (api: ElectronAPI, ...args: Args) => Promise<Result>
): ElectronInvoker<Args, Result> {
  let state = defaultState<Result>();

  const setState = (partial: Partial<RequestState<Result>>) => {
    state = { ...state, ...partial };
  };

  const invoke = async (...args: Args): Promise<Result> => {
    setState({ isLoading: true, error: null });

    try {
      const api = ensureElectronAPI();
      const result = await call(api, ...args);
      setState({ data: result, isLoading: false });
      return result;
    } catch (error) {
      setState({
        error: error instanceof Error ? error : new Error(String(error)),
        isLoading: false
      });
      throw error;
    }
  };

  const getState = () => state;

  const reset = () => {
    state = defaultState<Result>();
  };

  return {
    invoke,
    getState,
    reset
  };
}

export const notesApi = {
  getAll: createInvoker((api) => api.notes.getAll()),
  getMetadataByIds: createInvoker((api, noteIds: string[]) =>
    api.notes.getMetadataByIds
      ? api.notes.getMetadataByIds(noteIds)
      : Promise.resolve([])
  ),
  getById: createInvoker((api, noteId: string, options?: GetByIdOptions) =>
    api.notes.getById(noteId, options)
  ),
  getContent: createInvoker((api, noteId: string, options?: GetContentOptions) =>
    api.notes.getContent(noteId, options)
  ),
  getFrontmatterSuggestions: createInvoker((api) =>
    api.notes.getFrontmatterSuggestions
      ? api.notes.getFrontmatterSuggestions()
      : Promise.resolve({})
  ),
  getHeadings: createInvoker((api, noteId: string) => api.notes.getHeadings(noteId)),
  create: createInvoker((api, title: string, folderPath?: string) =>
    api.notes.create(title, folderPath)
  ),
  update: createInvoker((api, noteId: string, input: Parameters<ElectronAPI['notes']['update']>[1]) =>
    api.notes.update(noteId, input)
  ),
  delete: createInvoker((api, noteId: string) => api.notes.delete(noteId)),
  restore: createInvoker((api, noteId: string) => api.notes.restore(noteId)),
  search: createInvoker((api, input: Parameters<ElectronAPI['notes']['search']>[0]) =>
    api.notes.search(input)
  ),
  getFilesystemPath: createInvoker((api, noteId: string) =>
    api.notes.getFilesystemPath
      ? api.notes.getFilesystemPath(noteId)
      : Promise.resolve(undefined)
  ),
  setOpenFileWatchTargets: createInvoker((api, noteIds: string[]) =>
    api.notes.setOpenFileWatchTargets
      ? api.notes.setOpenFileWatchTargets(noteIds)
      : Promise.resolve()
  ),
  copyLinkToClipboard: createInvoker(
    (
      api,
      noteId: string,
      input: Parameters<NonNullable<ElectronAPI['notes']['copyLinkToClipboard']>>[1]
    ) =>
      api.notes.copyLinkToClipboard
        ? api.notes.copyLinkToClipboard(noteId, input)
        : Promise.resolve(false)
  ),
  showInFinder: createInvoker((api, noteId: string) => api.notes.showInFinder(noteId)),
  getPdfExportSession: createInvoker((api, sessionId: string) =>
    api.notes.getPdfExportSession
      ? api.notes.getPdfExportSession(sessionId)
      : Promise.resolve(null)
  ),
  createPdfExportSession: createInvoker(
    (
      api,
      noteId: string,
      input: Parameters<NonNullable<ElectronAPI['notes']['createPdfExportSession']>>[1]
    ) =>
      api.notes.createPdfExportSession
        ? api.notes.createPdfExportSession(noteId, input)
        : Promise.resolve(null)
  ),
  openPdfExportPreview: createInvoker((api, sessionId: string) =>
    api.notes.openPdfExportPreview
      ? api.notes.openPdfExportPreview(sessionId)
      : Promise.resolve(null)
  ),
  openPdfExportRenderSurface: createInvoker((api, sessionId: string) =>
    api.notes.openPdfExportRenderSurface
      ? api.notes.openPdfExportRenderSurface(sessionId)
      : Promise.resolve(null)
  ),
  exportPdf: createInvoker((api, noteId: string, input: Parameters<NonNullable<ElectronAPI['notes']['exportPdf']>>[1]) =>
    api.notes.exportPdf
      ? api.notes.exportPdf(noteId, input)
      : Promise.resolve({ canceled: true } as { canceled: boolean; filePath?: string })
  ),
  exportMarkdown: createInvoker((api, noteId: string, input: Parameters<NonNullable<ElectronAPI['notes']['exportMarkdown']>>[1]) =>
    api.notes.exportMarkdown
      ? api.notes.exportMarkdown(noteId, input)
      : Promise.resolve({ canceled: true } as { canceled: boolean; filePath?: string })
  )
};

export const foldersApi = {
  list: createInvoker((api, options?: Parameters<ElectronAPI['folders']['list']>[0]) =>
    api.folders.list(options)
  ),
  create: createInvoker((api, input: Parameters<ElectronAPI['folders']['create']>[0]) =>
    api.folders.create(input)
  ),
  rename: createInvoker((api, input: Parameters<ElectronAPI['folders']['rename']>[0]) =>
    api.folders.rename(input)
  ),
  delete: createInvoker((api, input: Parameters<ElectronAPI['folders']['delete']>[0]) =>
    api.folders.delete(input)
  ),
  moveNotes: createInvoker((api, input: Parameters<ElectronAPI['folders']['moveNotes']>[0]) =>
    api.folders.moveNotes(input)
  ),
  moveFolder: createInvoker((api, input: Parameters<ElectronAPI['folders']['moveFolder']>[0]) =>
    api.folders.moveFolder(input)
  ),
  showInFinder: createInvoker((api, folderPath: string) =>
    api.folders.showInFinder(folderPath)
  )
};

export const agentApi = {
  execute: createInvoker((api, input: Parameters<ElectronAPI['agent']['execute']>[0]) =>
    api.agent.execute(input)
  ),
  cancel: createInvoker((api, noteId: string) => api.agent.cancel(noteId)),
  cancelByTabId: createInvoker((api, tabId: string) => api.agent.cancelByTabId(tabId)),
  onStream: (callback: Parameters<ElectronAPI['agent']['onStream']>[0]): (() => void) => {
    const api = ensureElectronAPI();
    return api.agent.onStream(callback);
  }
};

export const filesApi = {
  search: createInvoker((api, input: Parameters<ElectronAPI['files']['search']>[0]) =>
    api.files.search(input)
  ),
  listDirectory: createInvoker((api, input: Parameters<ElectronAPI['files']['listDirectory']>[0]) =>
    api.files.listDirectory(input)
  ),
  open: createInvoker((api, input?: Parameters<ElectronAPI['files']['open']>[0]) => api.files.open(input))
};

export const imagesApi = {
  save: createInvoker((api, input: Parameters<ElectronAPI['images']['save']>[0]) =>
    api.images.save(input)
  ),
  pick: createInvoker((api, input?: Parameters<ElectronAPI['images']['pick']>[0]) => api.images.pick(input)),
  persistUrl: createInvoker((api, input: Parameters<ElectronAPI['images']['persistUrl']>[0]) =>
    api.images.persistUrl(input)
  ),
  copyFromPath: createInvoker((api, input: Parameters<ElectronAPI['images']['copyFromPath']>[0]) =>
    api.images.copyFromPath(input)
  ),
  copyFromNoteAsset: createInvoker(
    (
      api,
      input: Parameters<NonNullable<ElectronAPI['images']['copyFromNoteAsset']>>[0]
    ) =>
      api.images.copyFromNoteAsset
        ? api.images.copyFromNoteAsset(input)
        : Promise.reject(new Error('copyFromNoteAsset is unavailable'))
  )
};

type HtmlPreviewMaterializedCallback = (entry: HtmlPreviewMaterializedEntry) => void;
type HtmlPreviewFailedCallback = (entry: HtmlPreviewFailedEntry) => void;

const htmlPreviewMaterializedSubscriptions = new Map<
  string,
  Set<HtmlPreviewMaterializedCallback>
>();
const htmlPreviewFailedSubscriptions = new Map<
  string,
  Set<HtmlPreviewFailedCallback>
>();
let htmlPreviewMaterializedUnsubscribe: (() => void) | null = null;
let htmlPreviewFailedUnsubscribe: (() => void) | null = null;

const getHtmlPreviewMaterializedSubscriptionKey = (
  noteId: string,
  relativePath: string
): string => `${noteId}\u0000${relativePath}`;

const ensureHtmlPreviewMaterializedSubscription = (): void => {
  if (htmlPreviewMaterializedUnsubscribe) {
    return;
  }

  htmlPreviewMaterializedUnsubscribe = ensureElectronAPI().htmlPreview.onMaterialized((payload) => {
    for (const preview of payload.previews) {
      const callbacks = htmlPreviewMaterializedSubscriptions.get(
        getHtmlPreviewMaterializedSubscriptionKey(payload.noteId, preview.relativePath)
      );
      if (!callbacks) {
        continue;
      }

      for (const callback of callbacks) {
        callback(preview);
      }
    }
  });
};

const ensureHtmlPreviewFailedSubscription = (): void => {
  if (htmlPreviewFailedUnsubscribe) {
    return;
  }

  htmlPreviewFailedUnsubscribe = ensureElectronAPI().htmlPreview.onFailed((payload) => {
    for (const preview of payload.previews) {
      const callbacks = htmlPreviewFailedSubscriptions.get(
        getHtmlPreviewMaterializedSubscriptionKey(payload.noteId, preview.relativePath)
      );
      if (!callbacks) {
        continue;
      }

      for (const callback of callbacks) {
        callback(preview);
      }
    }
  });
};

export const htmlPreviewApi = {
  ensure: createInvoker(
    (api, input: Parameters<ElectronAPI['htmlPreview']['ensure']>[0]) =>
      api.htmlPreview.ensure(input)
  ),
  onMaterialized: (
    noteId: string,
    relativePath: string,
    callback: HtmlPreviewMaterializedCallback
  ): (() => void) => {
    ensureHtmlPreviewMaterializedSubscription();

    const key = getHtmlPreviewMaterializedSubscriptionKey(noteId, relativePath);
    const callbacks = htmlPreviewMaterializedSubscriptions.get(key) ?? new Set();
    callbacks.add(callback);
    htmlPreviewMaterializedSubscriptions.set(key, callbacks);

    return () => {
      const current = htmlPreviewMaterializedSubscriptions.get(key);
      if (!current) {
        return;
      }
      current.delete(callback);
      if (current.size === 0) {
        htmlPreviewMaterializedSubscriptions.delete(key);
      }

      if (htmlPreviewMaterializedSubscriptions.size === 0) {
        htmlPreviewMaterializedUnsubscribe?.();
        htmlPreviewMaterializedUnsubscribe = null;
      }
    };
  },
  onFailed: (
    noteId: string,
    relativePath: string,
    callback: HtmlPreviewFailedCallback
  ): (() => void) => {
    ensureHtmlPreviewFailedSubscription();

    const key = getHtmlPreviewMaterializedSubscriptionKey(noteId, relativePath);
    const callbacks = htmlPreviewFailedSubscriptions.get(key) ?? new Set();
    callbacks.add(callback);
    htmlPreviewFailedSubscriptions.set(key, callbacks);

    return () => {
      const current = htmlPreviewFailedSubscriptions.get(key);
      if (!current) {
        return;
      }
      current.delete(callback);
      if (current.size === 0) {
        htmlPreviewFailedSubscriptions.delete(key);
      }

      if (htmlPreviewFailedSubscriptions.size === 0) {
        htmlPreviewFailedUnsubscribe?.();
        htmlPreviewFailedUnsubscribe = null;
      }
    };
  }
};

type WebEmbedPreviewCallback = (result: DerivedPreviewResult) => void;

const webEmbedPreviewSubscriptions = new Map<string, Set<WebEmbedPreviewCallback>>();
const latestWebEmbedPreviewResults = new Map<string, DerivedPreviewResult>();
const WEB_EMBED_PREVIEW_RESULT_CACHE_LIMIT = 256;
let webEmbedPreviewUnsubscribe: (() => void) | null = null;

const webEmbedPreviewSubscriptionKey = (noteId: string, cacheKey: string): string =>
  `${noteId}\u0000${cacheKey}`;

const rememberWebEmbedPreviewResult = (noteId: string, result: DerivedPreviewResult): void => {
  const key = webEmbedPreviewSubscriptionKey(noteId, result.cacheKey);
  latestWebEmbedPreviewResults.delete(key);
  latestWebEmbedPreviewResults.set(key, result);
  if (latestWebEmbedPreviewResults.size > WEB_EMBED_PREVIEW_RESULT_CACHE_LIMIT) {
    const oldestKey = latestWebEmbedPreviewResults.keys().next().value;
    if (oldestKey) {
      latestWebEmbedPreviewResults.delete(oldestKey);
    }
  }
};

const ensureWebEmbedPreviewSubscription = (): void => {
  if (webEmbedPreviewUnsubscribe) {
    return;
  }

  const api = ensureElectronAPI().webEmbedPreview;
  if (!api) {
    return;
  }

  webEmbedPreviewUnsubscribe = api.subscribe((payload) => {
    for (const preview of payload.previews) {
      const cacheKey = preview.cacheKey ?? preview.descriptorKey ?? preview.relativePath;
      if (!cacheKey || !preview.kind) {
        continue;
      }
      const result: DerivedPreviewResult = {
        kind: preview.kind,
        sourceKey: preview.sourceKey ?? '',
        sourceSignature: preview.sourceSignature ?? preview.sourceKey ?? '',
        cacheKey,
        status: preview.status,
        assetRelativePath: preview.assetRelativePath,
        html: preview.html,
        metadata: preview.metadata,
        generatedAt: preview.generatedAt,
        expiresAt: preview.expiresAt,
        errorCode: preview.errorCode ?? preview.reason
      };
      const subscriptionKey = webEmbedPreviewSubscriptionKey(payload.noteId, cacheKey);
      rememberWebEmbedPreviewResult(payload.noteId, result);
      const callbacks = webEmbedPreviewSubscriptions.get(subscriptionKey);
      if (!callbacks) {
        continue;
      }
      for (const callback of callbacks) {
        callback(result);
      }
    }
  });
};

export const webEmbedPreviewApi = {
  ensure: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['webEmbedPreview']>['ensure']>[0]) =>
      api.webEmbedPreview
        ? api.webEmbedPreview.ensure(input)
        : Promise.resolve(null)
  ),
  subscribe: (
    noteId: string,
    cacheKey: string,
    callback: WebEmbedPreviewCallback
  ): (() => void) => {
    ensureWebEmbedPreviewSubscription();
    const subscriptionKey = webEmbedPreviewSubscriptionKey(noteId, cacheKey);
    const callbacks = webEmbedPreviewSubscriptions.get(subscriptionKey) ?? new Set();
    callbacks.add(callback);
    webEmbedPreviewSubscriptions.set(subscriptionKey, callbacks);
    const latestResult = latestWebEmbedPreviewResults.get(subscriptionKey);
    if (latestResult) {
      callback(latestResult);
    }

    return () => {
      const current = webEmbedPreviewSubscriptions.get(subscriptionKey);
      if (!current) {
        return;
      }
      current.delete(callback);
      if (current.size === 0) {
        webEmbedPreviewSubscriptions.delete(subscriptionKey);
      }
      if (webEmbedPreviewSubscriptions.size === 0) {
        webEmbedPreviewUnsubscribe?.();
        webEmbedPreviewUnsubscribe = null;
      }
    };
  }
};

export const remoteWebSurfaceApi = {
  create: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['create']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.create(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  updateBounds: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['updateBounds']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.updateBounds(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  hide: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['hide']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.hide(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  goBack: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['goBack']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.goBack(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  goForward: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['goForward']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.goForward(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  findInPage: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['findInPage']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.findInPage(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  openPageFind: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['openPageFind']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.openPageFind(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  stopFindInPage: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['stopFindInPage']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.stopFindInPage(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  copySelection: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['copySelection']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.copySelection(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  savePdf: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['savePdf']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.savePdf(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  showMenu: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['showMenu']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.showMenu(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  onNavigationState: (
    callback: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['onNavigationState']>[0]
  ): (() => void) => {
    const api = ensureElectronAPI();
    return api.remoteWebSurface ? api.remoteWebSurface.onNavigationState(callback) : () => undefined;
  },
  onSelection: (
    callback: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['onSelection']>[0]
  ): (() => void) => {
    const api = ensureElectronAPI();
    return api.remoteWebSurface ? api.remoteWebSurface.onSelection(callback) : () => undefined;
  },
  onFindResult: (
    callback: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['onFindResult']>[0]
  ): (() => void) => {
    const api = ensureElectronAPI();
    return api.remoteWebSurface ? api.remoteWebSurface.onFindResult(callback) : () => undefined;
  },
  onFindShortcut: (
    callback: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['onFindShortcut']>[0]
  ): (() => void) => {
    const api = ensureElectronAPI();
    return api.remoteWebSurface ? api.remoteWebSurface.onFindShortcut(callback) : () => undefined;
  },
  onCommandPaletteShortcut: (
    callback: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['onCommandPaletteShortcut']>[0]
  ): (() => void) => {
    const api = ensureElectronAPI();
    return api.remoteWebSurface
      ? api.remoteWebSurface.onCommandPaletteShortcut(callback)
      : () => undefined;
  },
  onFocused: (
    callback: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['onFocused']>[0]
  ): (() => void) => {
    const api = ensureElectronAPI();
    return api.remoteWebSurface ? api.remoteWebSurface.onFocused(callback) : () => undefined;
  },
  destroy: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['destroy']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.destroy(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  ),
  destroyForNote: createInvoker(
    (api, input: Parameters<NonNullable<ElectronAPI['remoteWebSurface']>['destroyForNote']>[0]) =>
      api.remoteWebSurface
        ? api.remoteWebSurface.destroyForNote(input)
        : Promise.resolve({ ok: false, errorCode: 'unsupported' as const })
  )
};

type VideoThumbnailMaterializedCallback = (entry: VideoThumbnailMaterializedEntry) => void;

const videoThumbnailMaterializedSubscriptions = new Map<
  string,
  Set<VideoThumbnailMaterializedCallback>
>();
let videoThumbnailMaterializedUnsubscribe: (() => void) | null = null;

const getVideoThumbnailMaterializedSubscriptionKey = (
  noteId: string,
  relativePath: string
): string => `${noteId}\u0000${relativePath}`;

const ensureVideoThumbnailMaterializedSubscription = (): void => {
  if (videoThumbnailMaterializedUnsubscribe) {
    return;
  }

  videoThumbnailMaterializedUnsubscribe = ensureElectronAPI().videoThumbnail.onMaterialized((payload) => {
    for (const thumbnail of payload.thumbnails) {
      const callbacks = videoThumbnailMaterializedSubscriptions.get(
        getVideoThumbnailMaterializedSubscriptionKey(payload.noteId, thumbnail.relativePath)
      );
      if (!callbacks) {
        continue;
      }

      for (const callback of callbacks) {
        callback(thumbnail);
      }
    }
  });
};

export const videoThumbnailApi = {
  ensure: createInvoker(
    (api, input: Parameters<ElectronAPI['videoThumbnail']['ensure']>[0]) =>
      api.videoThumbnail.ensure(input)
  ),
  onMaterialized: (
    noteId: string,
    relativePath: string,
    callback: (entry: VideoThumbnailMaterializedEntry) => void
  ): (() => void) => {
    ensureVideoThumbnailMaterializedSubscription();

    const key = getVideoThumbnailMaterializedSubscriptionKey(noteId, relativePath);
    const callbacks = videoThumbnailMaterializedSubscriptions.get(key) ?? new Set();
    callbacks.add(callback);
    videoThumbnailMaterializedSubscriptions.set(key, callbacks);

    return () => {
      const current = videoThumbnailMaterializedSubscriptions.get(key);
      if (!current) {
        return;
      }
      current.delete(callback);
      if (current.size === 0) {
        videoThumbnailMaterializedSubscriptions.delete(key);
      }

      if (videoThumbnailMaterializedSubscriptions.size === 0) {
        videoThumbnailMaterializedUnsubscribe?.();
        videoThumbnailMaterializedUnsubscribe = null;
      }
    };
  }
};


export const systemApi = {
  showEmojiPanel: createInvoker((api) => api.system.showEmojiPanel()),
  getMediaServerInfo: createInvoker((api) => api.system.getMediaServerInfo()),
  getGlobalShortcut: createInvoker((api) => api.system.getGlobalShortcut()),
  setGlobalShortcut: createInvoker((api, accelerator: string) => api.system.setGlobalShortcut(accelerator)),
  setGlobalShortcutEnabled: createInvoker((api, enabled: boolean) => api.system.setGlobalShortcutEnabled(enabled)),
  setImageAltTextMenuEnabled: createInvoker((api, enabled: boolean) =>
    api.system.setImageAltTextMenuEnabled
      ? api.system.setImageAltTextMenuEnabled(enabled)
      : Promise.resolve()
  ),
  createWindow: createInvoker((api, input?: Parameters<ElectronAPI['system']['createWindow']>[0]) =>
    api.system.createWindow(input)
  ),
  getWindowContext: createInvoker((api) => api.system.getWindowContext()),
  setFocusedNoteId: createInvoker((api, noteId: string | null) => api.system.setFocusedNoteId(noteId)),
  startWindowDrag: createInvoker((api, screenX: number, screenY: number) =>
    api.system.startWindowDrag(screenX, screenY)
  ),
  moveWindowDrag: createInvoker((api, screenX: number, screenY: number) =>
    api.system.moveWindowDrag(screenX, screenY)
  ),
  endWindowDrag: createInvoker((api) => api.system.endWindowDrag()),
  onGlobalShortcutActivated: (callback: () => void): (() => void) => {
    const api = ensureElectronAPI();
    return api.system.onGlobalShortcutActivated(callback);
  },
  onNativeMenuCommand: (callback: Parameters<NonNullable<ElectronAPI['system']['onNativeMenuCommand']>>[0]): (() => void) => {
    const api = ensureElectronAPI();
    return api.system.onNativeMenuCommand
      ? api.system.onNativeMenuCommand(callback)
      : () => {};
  }
};

export const filesystemApi = {
  openFolderDialog: createInvoker((api) => api.filesystem.openFolderDialog()),
  openFileDialog: createInvoker(
    (api, filters?: Array<{ name: string; extensions: string[] }>) =>
      api.filesystem.openFileDialog(filters)
  ),
  readDirectory: createInvoker((api, dirPath: string) => api.filesystem.readDirectory(dirPath)),
  getHomeDirectory: createInvoker((api) => api.filesystem.getHomeDirectory()),
  readFile: createInvoker((api, filePath: string) => api.filesystem.readFile(filePath))
};

export const grantedDirsApi = {
  list: createInvoker((api) => api.grantedDirs.list()),
  grant: createInvoker((api, input?: Parameters<ElectronAPI['grantedDirs']['grant']>[0]) => api.grantedDirs.grant(input)),
  revoke: createInvoker((api, dirPath: string) => api.grantedDirs.revoke(dirPath))
};

export const externalNotesApi = {
  close: createInvoker((api, noteId: string) => api.externalNotes.close(noteId)),
  closeByRoot: createInvoker((api, rootPath: string) => api.externalNotes.closeByRoot(rootPath)),
  resolveLink: createInvoker((api, sourceNoteId: string, target: string) =>
    api.externalNotes.resolveLink(sourceNoteId, target)
  )
};

export const shellApi = {
  revealPath: createInvoker((api, absolutePath: string) => api.shell.revealPath(absolutePath))
};

export const appConfigApi = {
  getWorkspacePath: createInvoker((api) => api.appConfig.getWorkspacePath()),
  setWorkspacePath: createInvoker((api, path: string | null) => api.appConfig.setWorkspacePath(path)),
  pickWorkspaceFolder: createInvoker((api) => api.appConfig.pickWorkspaceFolder()),
  restartApp: createInvoker((api) => api.appConfig.restartApp())
};
