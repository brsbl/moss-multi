// ported-from: packages/desktop/src/renderer/editor/nodes/html/useHtmlPreviewImage.ts @ 762abb777
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { htmlPreviewApi } from '../../../api/electron';
import { toDisplaySrc } from '../../utils/asset-url';
// moss-multi seam: html-preview (A§16)
import { htmlFrameSrc } from '@moss-multi/host/html-frame';
import { describeMossHtmlPreview } from '../../../../common/moss-html-runtime';
import type { DerivedPreviewStatus } from '../../../../common/derived-preview';

type HtmlPreviewPlaceholderState = 'ready' | 'loading' | 'error';

// Map the existing ready/loading/error reducer state onto the shared derived
// preview vocabulary without collapsing states or altering retry/pending
// behavior (the reducer mechanics are unchanged).
const HTML_PREVIEW_STATUS_TO_DERIVED: Record<
  HtmlPreviewPlaceholderState,
  DerivedPreviewStatus
> = {
  ready: 'resolved',
  loading: 'resolving',
  error: 'failed'
};
type HtmlPreviewRequestPriority = 'visible' | 'background';
type HtmlPreviewEnsureSource = 'cache' | 'legacy-cache' | 'generated';

interface HtmlPreviewState {
  descriptorKey: string;
  descriptorRelativePath: string;
  status: HtmlPreviewPlaceholderState;
  inFlight: boolean;
  visibleRelativePath: string | null;
  visibleNonce: number;
  pendingRelativePath: string | null;
  pendingNonce: number;
  loadedRelativePath: string | null;
}

interface HtmlPreviewEnsureResult {
  relativePath: string;
  source?: HtmlPreviewEnsureSource;
}

type HtmlPreviewAction =
  | {
      type: 'materialized';
      descriptorKey: string;
      descriptorRelativePath: string;
    }
  | {
      type: 'materialization-failed';
      descriptorKey: string;
      descriptorRelativePath: string;
    }
  | {
      type: 'visible-load';
      descriptorKey: string;
      descriptorRelativePath: string;
    }
  | {
      type: 'ensure-start';
      descriptorKey: string;
      descriptorRelativePath: string;
      revealLoading: boolean;
    }
  | {
      type: 'ensure-success';
      descriptorKey: string;
      descriptorRelativePath: string;
      resultRelativePath: string;
      force: boolean;
    }
  | {
      type: 'ensure-failed';
      descriptorKey: string;
      descriptorRelativePath: string;
    }
  | {
      type: 'visible-error';
      descriptorKey: string;
      descriptorRelativePath: string;
    }
  | {
      type: 'pending-load';
      descriptorKey: string;
      descriptorRelativePath: string;
    }
  | {
      type: 'pending-error';
      descriptorKey: string;
      descriptorRelativePath: string;
    };

type CurrentDescriptorAction =
  | { type: 'visible-load' }
  | { type: 'visible-error' }
  | { type: 'pending-load' }
  | { type: 'pending-error' };

const createInitialPreviewState = (
  descriptorKey: string,
  descriptorRelativePath: string
): HtmlPreviewState => ({
  descriptorKey,
  descriptorRelativePath,
  status: 'ready',
  inFlight: false,
  visibleRelativePath: descriptorRelativePath,
  visibleNonce: 0,
  pendingRelativePath: null,
  pendingNonce: 0,
  loadedRelativePath: null
});

const stateForActionDescriptor = (
  state: HtmlPreviewState,
  action: HtmlPreviewAction
): HtmlPreviewState => (
  state.descriptorKey === action.descriptorKey
    ? state
    : createInitialPreviewState(action.descriptorKey, action.descriptorRelativePath)
);

const htmlPreviewReducer = (
  state: HtmlPreviewState,
  action: HtmlPreviewAction
): HtmlPreviewState => {
  const current = stateForActionDescriptor(state, action);

  switch (action.type) {
    case 'materialized': {
      const alreadyLoaded =
        current.status === 'ready' &&
        current.loadedRelativePath === action.descriptorRelativePath;
      if (alreadyLoaded) {
        return current;
      }

      return {
        ...current,
        status: 'ready',
        visibleRelativePath: action.descriptorRelativePath,
        visibleNonce: Math.max(current.visibleNonce, current.pendingNonce) + 1,
        pendingRelativePath: null
      };
    }
    case 'materialization-failed':
      return {
        ...current,
        status: current.loadedRelativePath ? 'ready' : 'error',
        inFlight: false,
        pendingRelativePath: null,
        visibleRelativePath: current.loadedRelativePath
      };
    case 'visible-load':
      return {
        ...current,
        status: 'ready',
        loadedRelativePath: current.visibleRelativePath
      };
    case 'ensure-start':
      return {
        ...current,
        status:
          action.revealLoading && !current.loadedRelativePath && !current.visibleRelativePath
            ? 'loading'
            : 'ready',
        inFlight: true
      };
    case 'ensure-success': {
      const alreadyVisible =
        current.visibleRelativePath === action.resultRelativePath &&
        current.loadedRelativePath === action.resultRelativePath &&
        !action.force;
      if (alreadyVisible) {
        return {
          ...current,
          status: 'ready',
          inFlight: false,
          pendingRelativePath: null
        };
      }

      const isRecovery = !current.loadedRelativePath && !current.visibleRelativePath;
      const pendingNonce =
        action.force ||
        isRecovery ||
        current.visibleRelativePath === action.resultRelativePath ||
        current.pendingRelativePath === action.resultRelativePath
          ? Math.max(current.visibleNonce, current.pendingNonce) + 1
          : 0;

      return {
        ...current,
        status: current.visibleRelativePath ? 'ready' : 'loading',
        inFlight: false,
        pendingRelativePath: action.resultRelativePath,
        pendingNonce
      };
    }
    case 'ensure-failed':
      return {
        ...current,
        status:
          current.loadedRelativePath || current.visibleRelativePath
            ? 'ready'
            : 'error',
        inFlight: false,
        pendingRelativePath: null
      };
    case 'visible-error': {
      const hasLoadedPreview = !!current.loadedRelativePath;
      const hasAttemptedMaterializedPreview = current.visibleNonce > 0;
      return {
        ...current,
        visibleRelativePath: hasLoadedPreview ? current.loadedRelativePath : null,
        status:
          current.inFlight || hasLoadedPreview
            ? 'ready'
            : hasAttemptedMaterializedPreview
              ? 'error'
              : 'loading'
      };
    }
    case 'pending-load':
      if (!current.pendingRelativePath) {
        return current;
      }

      return {
        ...current,
        status: 'ready',
        visibleRelativePath: current.pendingRelativePath,
        visibleNonce: current.pendingNonce,
        loadedRelativePath: current.pendingRelativePath,
        pendingRelativePath: null
      };
    case 'pending-error':
      return {
        ...current,
        status: current.loadedRelativePath ? 'ready' : 'error',
        pendingRelativePath: null,
        visibleRelativePath: current.loadedRelativePath
      };
  }
};

const buildImageUrl = (
  relativePath: string | null,
  noteId: string | null,
  nonce: number
): string | null => {
  if (!relativePath) {
    return null;
  }

  const baseUrl = toDisplaySrc(relativePath, noteId);
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}v=${nonce}`;
};

export function useHtmlPreviewImage({
  noteId,
  rawHtml
}: {
  noteId: string | null;
  rawHtml: string;
}): {
  livePreview: boolean;
  previewImageUrl: string;
  preloadImageUrl: string | null;
  previewImageFailed: boolean;
  shouldRenderPreviewImage: boolean;
  status: HtmlPreviewPlaceholderState;
  derivedStatus: DerivedPreviewStatus;
  retryPreviewImage: () => void;
  handlePreviewImageLoad: () => void;
  handlePreviewImageError: () => void;
  handlePendingPreviewImageLoad: () => void;
  handlePendingPreviewImageError: () => void;
} {
  const previewEnsureRequestedRef = useRef<string | null>(null);
  const previewRequestIdRef = useRef(0);
  const currentPreviewDescriptor = useMemo(
    () => describeMossHtmlPreview(rawHtml),
    [rawHtml]
  );
  const currentDescriptorKey = `${currentPreviewDescriptor.cacheVersion}:${currentPreviewDescriptor.contentHash}:${currentPreviewDescriptor.relativePath}`;
  const currentDescriptorKeyRef = useRef(currentDescriptorKey);
  currentDescriptorKeyRef.current = currentDescriptorKey;

  const [storedPreviewState, dispatchPreviewState] = useReducer(
    htmlPreviewReducer,
    undefined,
    () => createInitialPreviewState(
      currentDescriptorKey,
      currentPreviewDescriptor.relativePath
    )
  );
  const previewState =
    storedPreviewState.descriptorKey === currentDescriptorKey
      ? storedPreviewState
      : createInitialPreviewState(currentDescriptorKey, currentPreviewDescriptor.relativePath);
  const previewImageUrl = buildImageUrl(
    previewState.visibleRelativePath,
    noteId,
    previewState.visibleNonce
  ) ?? '';
  const preloadImageUrl = buildImageUrl(
    previewState.pendingRelativePath,
    noteId,
    previewState.pendingNonce
  );

  useEffect(() => {
    if (!noteId) {
      return undefined;
    }

    const removeMaterializedListener = htmlPreviewApi.onMaterialized(
      noteId,
      currentPreviewDescriptor.relativePath,
      () => {
        dispatchPreviewState({
          type: 'materialized',
          descriptorKey: currentDescriptorKey,
          descriptorRelativePath: currentPreviewDescriptor.relativePath
        });
      }
    );
    const removeFailedListener = htmlPreviewApi.onFailed(
      noteId,
      currentPreviewDescriptor.relativePath,
      () => {
        dispatchPreviewState({
          type: 'materialization-failed',
          descriptorKey: currentDescriptorKey,
          descriptorRelativePath: currentPreviewDescriptor.relativePath
        });
      }
    );

    return () => {
      removeMaterializedListener();
      removeFailedListener();
    };
  }, [noteId, currentDescriptorKey, currentPreviewDescriptor.relativePath]);

  const dispatchForCurrentDescriptor = useCallback((action: CurrentDescriptorAction) => {
    dispatchPreviewState({
      ...action,
      descriptorKey: currentDescriptorKey,
      descriptorRelativePath: currentPreviewDescriptor.relativePath
    });
  }, [currentDescriptorKey, currentPreviewDescriptor.relativePath]);

  const previewStateRef = useRef(previewState);
  previewStateRef.current = previewState;

  const handlePreviewImageLoad = useCallback(() => {
    dispatchForCurrentDescriptor({ type: 'visible-load' });
  }, [dispatchForCurrentDescriptor]);

  const ensurePreviewImage = useCallback((options: {
    revealLoading?: boolean;
    priority?: HtmlPreviewRequestPriority;
    force?: boolean;
  } = {}) => {
    const revealLoading = options.revealLoading ?? false;
    const priority = options.priority ?? 'visible';
    const force = options.force ?? false;
    if (!noteId || previewEnsureRequestedRef.current === currentDescriptorKey) {
      return;
    }

    const requestDescriptorKey = currentDescriptorKey;
    const requestDescriptorRelativePath = currentPreviewDescriptor.relativePath;
    previewEnsureRequestedRef.current = requestDescriptorKey;
    dispatchPreviewState({
      type: 'ensure-start',
      descriptorKey: requestDescriptorKey,
      descriptorRelativePath: requestDescriptorRelativePath,
      revealLoading
    });

    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    void htmlPreviewApi.ensure.invoke({ noteId, rawHtml, priority, force })
      .then((result: HtmlPreviewEnsureResult | null) => {
        if (
          previewRequestIdRef.current !== requestId ||
          currentDescriptorKeyRef.current !== requestDescriptorKey
        ) {
          return;
        }
        if (!result) {
          dispatchPreviewState({
            type: 'ensure-failed',
            descriptorKey: requestDescriptorKey,
            descriptorRelativePath: requestDescriptorRelativePath
          });
          return;
        }

        dispatchPreviewState({
          type: 'ensure-success',
          descriptorKey: requestDescriptorKey,
          descriptorRelativePath: requestDescriptorRelativePath,
          resultRelativePath: result.relativePath,
          force
        });
      })
      .catch(() => {
        if (
          previewRequestIdRef.current !== requestId ||
          currentDescriptorKeyRef.current !== requestDescriptorKey
        ) {
          return;
        }
        dispatchPreviewState({
          type: 'ensure-failed',
          descriptorKey: requestDescriptorKey,
          descriptorRelativePath: requestDescriptorRelativePath
        });
      })
      .finally(() => {
        if (
          previewRequestIdRef.current !== requestId ||
          currentDescriptorKeyRef.current !== requestDescriptorKey
        ) {
          return;
        }
        previewEnsureRequestedRef.current = null;
      });
  }, [currentDescriptorKey, currentPreviewDescriptor.relativePath, noteId, rawHtml]);

  const recoveryAttemptedRef = useRef<string | null>(null);

  const handlePreviewImageError = useCallback(() => {
    const state = previewStateRef.current;
    dispatchForCurrentDescriptor({ type: 'visible-error' });

    if (
      noteId &&
      !state.loadedRelativePath &&
      state.visibleNonce === 0 &&
      !state.inFlight &&
      recoveryAttemptedRef.current !== currentDescriptorKey
    ) {
      recoveryAttemptedRef.current = currentDescriptorKey;
      const recoveryKey = currentDescriptorKey;
      const recoveryPath = currentPreviewDescriptor.relativePath;

      void htmlPreviewApi.ensure.invoke({ noteId, rawHtml, priority: 'visible', force: false })
        .then((result: HtmlPreviewEnsureResult | null) => {
          if (currentDescriptorKeyRef.current !== recoveryKey) return;
          if (!result) {
            dispatchPreviewState({
              type: 'ensure-failed',
              descriptorKey: recoveryKey,
              descriptorRelativePath: recoveryPath
            });
            return;
          }
          dispatchPreviewState({
            type: 'ensure-success',
            descriptorKey: recoveryKey,
            descriptorRelativePath: recoveryPath,
            resultRelativePath: result.relativePath,
            force: false
          });
        })
        .catch(() => {
          if (currentDescriptorKeyRef.current !== recoveryKey) return;
          dispatchPreviewState({
            type: 'ensure-failed',
            descriptorKey: recoveryKey,
            descriptorRelativePath: recoveryPath
          });
        });
    }
  }, [noteId, rawHtml, currentDescriptorKey, currentPreviewDescriptor.relativePath, dispatchForCurrentDescriptor]);

  const handlePendingPreviewImageLoad = useCallback(() => {
    dispatchForCurrentDescriptor({ type: 'pending-load' });
  }, [dispatchForCurrentDescriptor]);

  const handlePendingPreviewImageError = useCallback(() => {
    dispatchForCurrentDescriptor({ type: 'pending-error' });
  }, [dispatchForCurrentDescriptor]);

  const retryPreviewImage = useCallback(() => {
    ensurePreviewImage({
      revealLoading: true,
      priority: 'visible',
      force: true
    });
  }, [ensurePreviewImage]);

  // moss-multi seam: html-preview (A§16; P:Notes): a browser never loads moss-asset://, so a cached preview
  // screenshot that resolves there is never requested (the page CSP would refuse it with a console error). Where the
  // host serves the sandboxed frame document, the block's static preview is the live iframe itself (`livePreview`);
  // elsewhere it reads as unavailable.
  const screenshotLoads = !toDisplaySrc(currentPreviewDescriptor.relativePath, noteId).startsWith('moss-asset://');
  const livePreview = !screenshotLoads && htmlFrameSrc() !== null;
  const status = livePreview ? 'ready' : screenshotLoads || previewState.status === 'loading' ? previewState.status : 'error';
  return {
    livePreview,
    previewImageUrl: screenshotLoads ? previewImageUrl : '',
    preloadImageUrl: screenshotLoads ? preloadImageUrl : null,
    previewImageFailed: status === 'error',
    shouldRenderPreviewImage: screenshotLoads && !!previewState.visibleRelativePath,
    status,
    derivedStatus: HTML_PREVIEW_STATUS_TO_DERIVED[status],
    retryPreviewImage,
    handlePreviewImageLoad,
    handlePreviewImageError,
    handlePendingPreviewImageLoad,
    handlePendingPreviewImageError
  };
}
