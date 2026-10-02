// ported-from: packages/desktop/src/renderer/PdfExportApp.tsx @ 762abb777
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Provider, createStore } from 'jotai';
import {
  $getRoot,
  $isElementNode,
  type LexicalEditor,
  type LexicalNode,
  type SerializedEditorState
} from 'lexical';

import {
  noteCollapsedHeadingsAtom,
  noteCommentsMapAtom,
  type NoteComment
} from '@moss/shared';

import type { PdfExportSessionPayload } from '../common/noteTypes';
import { notesApi } from './api/electron';
import { MarkdownEditor } from './editor/MarkdownEditor';
import { $isTabGroupNode, type TabGroupNode } from './editor/nodes/TabGroupNode';

import './PdfExportApp.css';

const LETTER_PAGE_RATIO = 11 / 8.5;
const RESOURCE_WAIT_TIMEOUT_MS = 5000;
const HTML_PREVIEW_WAIT_TIMEOUT_MS = 15000;

const setPdfExportStatus = (status: 'loading' | 'ready' | 'error', errorMessage?: string): void => {
  document.body.dataset.pdfExportStatus = status;
  if (errorMessage) {
    document.body.dataset.pdfExportError = errorMessage;
  } else {
    delete document.body.dataset.pdfExportError;
  }
};

const getPdfExportSessionId = (): string | null => {
  const sessionId = new URLSearchParams(window.location.search).get('pdfExportSessionId');
  return sessionId && sessionId.trim().length > 0 ? sessionId.trim() : null;
};

const isPdfExportPreviewMode = (): boolean => {
  return new URLSearchParams(window.location.search).get('pdfExportPreview') === '1';
};

const shouldKeepWithNextPreviewNode = (node: HTMLElement): boolean => {
  return /^H[1-6]$/.test(node.tagName);
};

const collectTabGroupNodes = (node: LexicalNode): TabGroupNode[] => {
  const groups: TabGroupNode[] = [];

  if ($isTabGroupNode(node)) {
    groups.push(node);
  }

  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      groups.push(...collectTabGroupNodes(child));
    }
  }

  return groups;
};

const waitForAnimationFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

const waitForTwoAnimationFrames = async (): Promise<void> => {
  await waitForAnimationFrame();
  await waitForAnimationFrame();
};

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number): Promise<T | void> =>
  Promise.race([
    promise,
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    })
  ]);

const waitForImage = async (image: HTMLImageElement): Promise<void> => {
  if (image.complete) {
    if (typeof image.decode === 'function') {
      try {
        await withTimeout(image.decode(), RESOURCE_WAIT_TIMEOUT_MS);
      } catch {
        // Decode failures still represent a stable browser fallback state.
      }
    }
    return;
  }

  await withTimeout(
    new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    }),
    RESOURCE_WAIT_TIMEOUT_MS
  );
};

const waitForVideo = async (video: HTMLVideoElement): Promise<void> => {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA || video.error) {
    return;
  }

  await withTimeout(
    new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener('error', () => resolve(), { once: true });
    }),
    RESOURCE_WAIT_TIMEOUT_MS
  );
};

const waitForIframe = async (iframe: HTMLIFrameElement): Promise<void> => {
  try {
    if (iframe.contentDocument?.readyState === 'complete') {
      return;
    }
  } catch {
    return;
  }

  await withTimeout(
    new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
      iframe.addEventListener('error', () => resolve(), { once: true });
    }),
    RESOURCE_WAIT_TIMEOUT_MS
  );
};

const preparePdfExportResourceLoading = (root: HTMLElement): void => {
  root.querySelectorAll('img').forEach((image) => {
    image.loading = 'eager';
    image.decoding = 'sync';
  });

  root.querySelectorAll('video').forEach((video) => {
    video.preload = 'metadata';
    try {
      video.load();
    } catch {
      // Some embedded media wrappers expose inert video elements in export.
    }
  });
};

const waitForStableLayout = async (root: HTMLElement): Promise<void> => {
  if (typeof MutationObserver === 'undefined') {
    await waitForTwoAnimationFrames();
    return;
  }

  await new Promise<void>((resolve) => {
    let stableFrameCount = 0;
    let completed = false;
    let observer: MutationObserver | null = null;
    let timeout = 0;

    const complete = () => {
      if (completed) {
        return;
      }
      completed = true;
      window.clearTimeout(timeout);
      observer?.disconnect();
      resolve();
    };

    observer = new MutationObserver(() => {
      stableFrameCount = 0;
    });

    const tick = () => {
      if (completed) {
        return;
      }
      stableFrameCount += 1;
      if (stableFrameCount >= 2) {
        complete();
        return;
      }
      requestAnimationFrame(tick);
    };

    timeout = window.setTimeout(complete, RESOURCE_WAIT_TIMEOUT_MS);
    observer.observe(root, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    requestAnimationFrame(tick);
  });
};

const waitForHtmlPreviewLoading = async (root: HTMLElement): Promise<void> => {
  const loadingSelector = '[data-testid="html-preview-loading"], [data-testid="chart-loading"]';

  if (!root.querySelector(loadingSelector)) {
    return;
  }

  await new Promise<void>((resolve) => {
    let completed = false;
    let observer: MutationObserver | null = null;
    let timeout = 0;

    const complete = () => {
      if (completed) {
        return;
      }
      completed = true;
      window.clearTimeout(timeout);
      observer?.disconnect();
      resolve();
    };

    observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
          if (!root.querySelector(loadingSelector)) {
            complete();
          }
        });

    timeout = window.setTimeout(() => complete(), HTML_PREVIEW_WAIT_TIMEOUT_MS);

    if (!root.querySelector(loadingSelector)) {
      complete();
      return;
    }

    observer?.observe(root, {
      attributes: true,
      childList: true,
      subtree: true
    });
  });
};

const waitForPdfExportResources = async (root: HTMLElement): Promise<void> => {
  preparePdfExportResourceLoading(root);

  if ('fonts' in document && document.fonts?.ready) {
    await withTimeout(document.fonts.ready, RESOURCE_WAIT_TIMEOUT_MS);
  }

  await Promise.all(Array.from(root.querySelectorAll('img')).map(waitForImage));
  await Promise.all(Array.from(root.querySelectorAll('video')).map(waitForVideo));
  await Promise.all(Array.from(root.querySelectorAll('iframe')).map(waitForIframe));
  await waitForStableLayout(root);
};

const syncFormControlValues = (source: HTMLElement, clone: HTMLElement): void => {
  const sourceTextareas = Array.from(source.querySelectorAll('textarea'));
  const clonedTextareas = Array.from(clone.querySelectorAll('textarea'));
  sourceTextareas.forEach((textarea, index) => {
    const clonedTextarea = clonedTextareas[index];
    if (!clonedTextarea) {
      return;
    }
    clonedTextarea.value = textarea.value;
    clonedTextarea.textContent = textarea.value;
  });

  const sourceInputs = Array.from(source.querySelectorAll('input'));
  const clonedInputs = Array.from(clone.querySelectorAll('input'));
  sourceInputs.forEach((input, index) => {
    const clonedInput = clonedInputs[index];
    if (!clonedInput) {
      return;
    }
    clonedInput.value = input.value;
    clonedInput.setAttribute('value', input.value);
    if (input.checked) {
      clonedInput.setAttribute('checked', '');
    } else {
      clonedInput.removeAttribute('checked');
    }
  });

  const sourceOptions = Array.from(source.querySelectorAll('option'));
  const clonedOptions = Array.from(clone.querySelectorAll('option'));
  sourceOptions.forEach((option, index) => {
    const clonedOption = clonedOptions[index];
    if (!clonedOption) {
      return;
    }
    if (option.selected) {
      clonedOption.setAttribute('selected', '');
    } else {
      clonedOption.removeAttribute('selected');
    }
  });
};

const clonePreviewNode = (sourceNode: HTMLElement): HTMLElement => {
  const clone = sourceNode.cloneNode(true) as HTMLElement;

  const sourceCanvases = Array.from(sourceNode.querySelectorAll('canvas'));
  const clonedCanvases = Array.from(clone.querySelectorAll('canvas'));

  sourceCanvases.forEach((canvas, index) => {
    const clonedCanvas = clonedCanvases[index];
    if (!clonedCanvas) {
      return;
    }

    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch {
      return;
    }

    if (!dataUrl) {
      return;
    }

    const image = document.createElement('img');
    image.src = dataUrl;
    image.alt = clonedCanvas.getAttribute('aria-label') ?? '';
    image.className = clonedCanvas.className;
    image.draggable = false;
    image.width = canvas.width;
    image.height = canvas.height;

    const canvasStyle = clonedCanvas.getAttribute('style');
    if (canvasStyle) {
      image.setAttribute('style', canvasStyle);
    }

    const renderedRect = canvas.getBoundingClientRect();
    if (!image.className.trim() && renderedRect.width > 0 && renderedRect.height > 0) {
      image.style.width = `${renderedRect.width}px`;
      image.style.height = `${renderedRect.height}px`;
    }

    clonedCanvas.replaceWith(image);
  });

  syncFormControlValues(sourceNode, clone);
  return clone;
};

type PreviewUnit = {
  itemIndex?: number;
  listId?: string;
  listShell?: HTMLElement;
  listStart?: number;
  node: HTMLElement;
};

type PreviewPage = {
  html: string;
  oversized?: boolean;
};

const isSplittableListNode = (node: HTMLElement): boolean => {
  if (node.tagName !== 'OL' && node.tagName !== 'UL') {
    return false;
  }

  return Array.from(node.children).some((child) => child.tagName === 'LI');
};

const buildPreviewUnits = (sourceNodes: HTMLElement[]): PreviewUnit[] => {
  const units: PreviewUnit[] = [];

  sourceNodes.forEach((sourceNode, sourceIndex) => {
    if (!isSplittableListNode(sourceNode)) {
      units.push({ node: clonePreviewNode(sourceNode) });
      return;
    }

    const listShell = sourceNode.cloneNode(false) as HTMLElement;
    const listStart = Number.parseInt(sourceNode.getAttribute('start') ?? '1', 10) || 1;
    const listId = `list-${sourceIndex}`;

    Array.from(sourceNode.children).forEach((child, itemIndex) => {
      if (!(child instanceof HTMLElement) || child.tagName !== 'LI') {
        return;
      }

      units.push({
        itemIndex,
        listId,
        listShell,
        listStart,
        node: clonePreviewNode(child)
      });
    });
  });

  return units;
};

const appendPreviewUnit = (content: HTMLElement, unit: PreviewUnit): (() => void) => {
  if (!unit.listId || !unit.listShell) {
    content.appendChild(unit.node);
    return () => unit.node.remove();
  }

  const previousList = content.lastElementChild as HTMLElement | null;
  const shouldAppendToPreviousList = previousList?.dataset.pdfPreviewListId === unit.listId;
  const listElement = shouldAppendToPreviousList
    ? previousList
    : (unit.listShell.cloneNode(false) as HTMLElement);
  const createdList = !shouldAppendToPreviousList;

  if (createdList) {
    listElement.dataset.pdfPreviewListId = unit.listId;
    if (listElement.tagName === 'OL' && typeof unit.itemIndex === 'number') {
      listElement.setAttribute('start', String((unit.listStart ?? 1) + unit.itemIndex));
    }
    content.appendChild(listElement);
  }

  listElement.appendChild(unit.node);

  return () => {
    unit.node.remove();
    if (createdList) {
      listElement.remove();
    }
  };
};

export default function PdfExportApp() {
  const store = useMemo(() => createStore(), []);
  const isPreview = useMemo(() => isPdfExportPreviewMode(), []);
  const [session, setSession] = useState<PdfExportSessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [tabStateApplied, setTabStateApplied] = useState(false);
  const [previewPages, setPreviewPages] = useState<PreviewPage[]>([]);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const measurePageRef = useRef<HTMLElement | null>(null);
  const measureContentRef = useRef<HTMLDivElement | null>(null);
  const previewSandboxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.body.dataset.pdfExportPreview = isPreview ? 'true' : 'false';
  }, [isPreview]);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setPdfExportStatus('loading');

      const sessionId = getPdfExportSessionId();
      if (!sessionId) {
        const message = 'Missing PDF export session id';
        setError(message);
        setPdfExportStatus('error', message);
        return;
      }

      try {
        const payload = await notesApi.getPdfExportSession.invoke(sessionId);
        if (cancelled) {
          return;
        }
        if (!payload) {
          throw new Error('PDF export session not found');
        }

        document.title = payload.title;
        store.set(
          noteCommentsMapAtom(payload.noteId),
          (payload.commentsMap ?? {}) as Record<string, NoteComment>
        );
        store.set(
          noteCollapsedHeadingsAtom(payload.noteId),
          payload.collapsedHeadingIdentities ?? []
        );

        setSession(payload);
        setError(null);
        setEditorReady(false);
        setTabStateApplied(false);
        setPreviewPages([]);
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        const message =
          loadError instanceof Error ? loadError.message : 'Failed to load PDF export session';
        setError(message);
        setSession(null);
        setPdfExportStatus('error', message);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [store]);

  const handleEditorReady = useCallback((editor: LexicalEditor) => {
    setEditorReady(true);

    const activeIndices = session?.tabGroupActiveIndices ?? [];
    editor.update(() => {
      const groups = collectTabGroupNodes($getRoot());
      groups.forEach((group, index) => {
        const nextActiveIndex = activeIndices[index];
        if (typeof nextActiveIndex === 'number') {
          group.setActiveIndex(nextActiveIndex);
        }
      });
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const groupElements = Array.from(document.querySelectorAll<HTMLElement>('.moss-tab-group'));
        groupElements.forEach((groupElement, groupIndex) => {
          const nextActiveIndex = activeIndices[groupIndex] ?? 0;
          const panels = Array.from(groupElement.querySelectorAll<HTMLElement>('[data-tab-panel]'));
          panels.forEach((panel, panelIndex) => {
            if (panelIndex === nextActiveIndex) {
              panel.style.display = '';
              panel.setAttribute('data-active', '');
            } else {
              panel.style.display = 'none';
              panel.removeAttribute('data-active');
            }
          });
        });
        setTabStateApplied(true);
      });
    });
  }, [session]);

  const paginatePreviewPages = useCallback(() => {
    if (!isPreview) {
      return;
    }

    const measurePage = measurePageRef.current;
    const measureContent = measureContentRef.current;
    const previewSandbox = previewSandboxRef.current;

    if (!measurePage || !measureContent || !previewSandbox) {
      setPreviewPages([]);
      return;
    }

    const titleElement = measureContent.querySelector('h1');
    const editorRoot = measureContent.querySelector<HTMLElement>('[data-moss-note-editor-root="true"]');
    if (!titleElement || !editorRoot) {
      setPreviewPages([]);
      return;
    }

    const measurePageStyle = window.getComputedStyle(measurePage);
    const paddingTop = Number.parseFloat(measurePageStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(measurePageStyle.paddingBottom) || 0;
    const pageWidth = measurePage.getBoundingClientRect().width;
    const pageHeight = pageWidth * LETTER_PAGE_RATIO;
    const availableHeight = Math.max(1, pageHeight - paddingTop - paddingBottom);

    const sourceUnits = buildPreviewUnits([
      titleElement,
      ...Array.from(editorRoot.children).filter((node): node is HTMLElement => node instanceof HTMLElement)
    ]);

    previewSandbox.innerHTML = '';
    const nextPages: PreviewPage[] = [];

    const createMeasurementPage = () => {
      const page = document.createElement('section');
      page.className = 'pdf-export-page pdf-export-page--measure-frame';
      const content = document.createElement('div');
      content.className = 'pdf-export-content pdf-export-content--preview-clone';
      page.appendChild(content);
      previewSandbox.appendChild(page);
      return { page, content, oversized: false };
    };

    let currentPage = createMeasurementPage();

    for (let index = 0; index < sourceUnits.length; index += 1) {
      const sourceUnit = sourceUnits[index];
      const nextUnit = sourceUnits[index + 1];
      const unitsToAppend =
        nextUnit && shouldKeepWithNextPreviewNode(sourceUnit.node)
          ? [sourceUnit, nextUnit]
          : [sourceUnit];
      const hadContentBeforeAppend = currentPage.content.childElementCount > 0;
      const cleanupAppendedUnits = unitsToAppend.map((unit) =>
        appendPreviewUnit(currentPage.content, unit)
      );

      if (currentPage.content.scrollHeight > availableHeight + 1 && hadContentBeforeAppend) {
        [...cleanupAppendedUnits].reverse().forEach((cleanup) => cleanup());
        nextPages.push({
          html: currentPage.content.innerHTML,
          oversized: currentPage.oversized
        });
        previewSandbox.removeChild(currentPage.page);
        currentPage = createMeasurementPage();
        unitsToAppend.forEach((unit) => appendPreviewUnit(currentPage.content, unit));
        currentPage.oversized = currentPage.content.scrollHeight > availableHeight + 1;
      } else if (currentPage.content.scrollHeight > availableHeight + 1) {
        currentPage.oversized = true;
      }

      if (unitsToAppend.length > 1) {
        index += unitsToAppend.length - 1;
      }
    }

    if (currentPage.content.childElementCount > 0) {
      nextPages.push({
        html: currentPage.content.innerHTML,
        oversized: currentPage.oversized
      });
    }

    previewSandbox.innerHTML = '';
    setPreviewPages(nextPages);
  }, [isPreview]);

  useEffect(() => {
    if (!isPreview || !session || error || !editorReady || !tabStateApplied) {
      return;
    }

    let cancelled = false;
    const preparePreviewPages = async (): Promise<void> => {
      await waitForTwoAnimationFrames();
      const measureContent = measureContentRef.current;
      if (!measureContent || cancelled) {
        return;
      }

      preparePdfExportResourceLoading(measureContent);
      await waitForHtmlPreviewLoading(measureContent);
      if (cancelled) {
        return;
      }

      await waitForPdfExportResources(measureContent);
      if (cancelled) {
        return;
      }

      await waitForTwoAnimationFrames();
      if (!cancelled) {
        paginatePreviewPages();
      }
    };

    void preparePreviewPages().catch((previewError) => {
      if (cancelled) {
        return;
      }
      const message =
        previewError instanceof Error ? previewError.message : 'Failed to prepare PDF preview pages';
      setPdfExportStatus('error', message);
      setError(message);
    });

    return () => {
      cancelled = true;
    };
  }, [editorReady, error, isPreview, paginatePreviewPages, session, tabStateApplied]);

  useEffect(() => {
    if (!session || error || !editorReady || !tabStateApplied) {
      return;
    }

    if (isPreview && previewPages.length === 0) {
      return;
    }

    let cancelled = false;
    const waitForReady = async (): Promise<void> => {
      await waitForTwoAnimationFrames();
      const shell = shellRef.current;
      if (!shell || cancelled) {
        return;
      }
      await waitForPdfExportResources(shell);
      if (!cancelled) {
        setPdfExportStatus('ready');
      }
    };

    void waitForReady().catch((readyError) => {
      if (cancelled) {
        return;
      }
      const message =
        readyError instanceof Error ? readyError.message : 'Failed to prepare PDF export surface';
      setPdfExportStatus('error', message);
      setError(message);
    });

    return () => {
      cancelled = true;
    };
  }, [editorReady, error, isPreview, previewPages.length, session, tabStateApplied]);

  const renderPrintableContent = () => (
    <>
      <h1 className="mx-auto mb-1 w-full max-w-canvas-prose text-left text-3xl font-semibold text-ink-default">
        {session?.title}
      </h1>
      <MarkdownEditor
        noteId={session?.noteId ?? ''}
        value={session?.markdown ?? ''}
        onChange={() => undefined}
        readOnly
        initialSerializedState={(session?.serializedEditorState ?? null) as SerializedEditorState | null}
        onReady={handleEditorReady}
      />
    </>
  );

  if (error) {
    return (
      <div className="pdf-export-shell">
        <div className="pdf-export-message">{error}</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="pdf-export-shell">
        <div className="pdf-export-message">Preparing PDF export...</div>
      </div>
    );
  }

  return (
    <Provider store={store}>
      <div ref={shellRef} className="pdf-export-shell">
        {isPreview ? (
          <>
            <div className="pdf-export-preview-stack">
              {previewPages.map((page, pageIndex) => (
                <main
                  key={pageIndex}
                  className="pdf-export-page"
                  data-pdf-preview-page="true"
                  data-pdf-preview-oversized={page.oversized ? 'true' : undefined}
                >
                  <div
                    className="pdf-export-content pdf-export-content--preview-clone"
                    dangerouslySetInnerHTML={{ __html: page.html }}
                  />
                </main>
              ))}
            </div>
            <div className="pdf-export-measure-layer" aria-hidden="true">
              <main ref={measurePageRef} className="pdf-export-page pdf-export-page--measure">
                <div ref={measureContentRef} className="pdf-export-content">
                  {renderPrintableContent()}
                </div>
              </main>
              <div ref={previewSandboxRef} className="pdf-export-preview-sandbox" />
            </div>
          </>
        ) : (
          <main className="pdf-export-page">
            <div className="pdf-export-content">{renderPrintableContent()}</div>
          </main>
        )}
      </div>
    </Provider>
  );
}
