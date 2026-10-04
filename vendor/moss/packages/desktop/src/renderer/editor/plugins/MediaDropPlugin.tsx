// ported-from: packages/desktop/src/renderer/editor/plugins/MediaDropPlugin.tsx @ 762abb777
import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  $insertNodes,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $isElementNode,
  COMMAND_PRIORITY_HIGH,
  DROP_COMMAND,
  DRAGOVER_COMMAND,
  type LexicalEditor,
  type LexicalNode
} from 'lexical';
import {
  $getTableCellNodeFromLexicalNode,
  $isTableCellNode
} from '@lexical/table';

import { $createImageNode } from '../nodes/ImageNode';
import { $createVideoNode } from '../nodes/VideoNode';
import { imagesApi } from '../../api/electron';
import { EDITOR_CHROME_COLORS } from '../colors';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';
import { MEDIA_UPLOAD_REFUSED, refuseInput } from '@moss-multi/host/refusal';
import {
  extractAltFromUrl,
  isHttpsImageUrl,
  preflightRemoteImageUrl
} from '../utils/remote-image-url';
import { isYouTubeUrl } from '../utils/video-url';

/** Extension to MIME type mapping - single source of truth */
const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

const VIDEO_EXT_TO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
};

const MEDIA_EXT_TO_MIME: Record<string, string> = {
  ...IMAGE_EXT_TO_MIME,
  ...VIDEO_EXT_TO_MIME
};

const ALLOWED_IMAGE_MIME_TYPES = new Set(Object.values(IMAGE_EXT_TO_MIME));
const ALLOWED_VIDEO_MIME_TYPES = new Set(Object.values(VIDEO_EXT_TO_MIME));
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

/** Get file extension from filename */
function getExt(filename: string): string {
  return filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
}

/** Extract basename from a local filesystem path (POSIX/Windows). */
function getFilenameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? '';
}

/** Check if file is a supported image (by MIME type or extension) */
function isImageFile(file: File): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(file.type) || getExt(file.name) in IMAGE_EXT_TO_MIME;
}

/** Check if file is a supported video (by MIME type or extension) */
function isVideoFile(file: File): boolean {
  return ALLOWED_VIDEO_MIME_TYPES.has(file.type) || getExt(file.name) in VIDEO_EXT_TO_MIME;
}

/** Get reliable MIME type (from file.type or derived from extension) */
function getImageMimeType(file: File): string {
  return ALLOWED_IMAGE_MIME_TYPES.has(file.type)
    ? file.type
    : (IMAGE_EXT_TO_MIME[getExt(file.name)] ?? 'application/octet-stream');
}

/**
 * Parse a local filesystem media reference from dragged URL/text.
 * Accepts file:// URLs and absolute filesystem paths.
 */
function parseLocalMediaReference(value: string): { filePath: string; filename: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let filePath: string | null = null;

  if (trimmed.startsWith('file://')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'file:') {
        return null;
      }
      let pathname = decodeURIComponent(parsed.pathname);
      if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
        pathname = pathname.slice(1);
      }
      filePath = pathname;
    } catch {
      return null;
    }
  } else if (trimmed.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    filePath = trimmed;
  }

  if (!filePath) {
    return null;
  }

  const filename = getFilenameFromPath(filePath);
  if (!filename || !(getExt(filename) in MEDIA_EXT_TO_MIME)) {
    return null;
  }

  return { filePath, filename };
}

function parseLocalMediaReferencesFromUriList(uriList: string): Array<{ filePath: string; filename: string }> {
  return uriList
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => parseLocalMediaReference(line))
    .filter((reference): reference is { filePath: string; filename: string } => reference !== null);
}

/**
 * Read a File object as base64 data
 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the data URL prefix (e.g., "data:image/png;base64,")
      const base64Data = result.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Extract the first URL from a text/uri-list.
 * Format: lines starting with # are comments, each non-comment line is a URL.
 */
function extractUrlFromUriList(uriList: string): string | null {
  const url = uriList
    .split('\n')
    .find((line) => line.trim() && !line.startsWith('#'))
    ?.trim();
  return url || null;
}

type DropInsertionTarget =
  | { kind: 'after-node'; nodeKey: string }
  | { kind: 'append-to-cell'; cellKey: string };

function getCaretRangeFromPoint(clientX: number, clientY: number): Range | null {
  const range = document.caretRangeFromPoint?.(clientX, clientY);
  if (range) {
    return range;
  }

  const caretPosition = document.caretPositionFromPoint?.(clientX, clientY);
  if (!caretPosition) {
    return null;
  }

  const fallbackRange = document.createRange();
  fallbackRange.setStart(caretPosition.offsetNode, caretPosition.offset);
  fallbackRange.collapse(true);
  return fallbackRange;
}

/**
 * Resolve a drop event's coordinates to the nearest Lexical insertion target.
 * Table-cell drops resolve to the direct child block inside that cell, so media
 * lands inside the cell instead of after the table.
 */
function resolveDropInsertionTarget(
  event: DragEvent,
  editor: LexicalEditor
): DropInsertionTarget | null {
  let rootElement: HTMLElement | null;
  try {
    rootElement = editor.getRootElement();
  } catch {
    return null;
  }
  if (!rootElement) return null;

  // Use the browser's caret API to find the DOM node at drop coordinates
  const range = getCaretRangeFromPoint(event.clientX, event.clientY);
  if (!range) return null;

  const domNode = range.startContainer;
  let insertionTarget: DropInsertionTarget | null = null;

  editor.read(() => {
    let lexicalNode: LexicalNode | null = $getNearestNodeFromDOMNode(domNode);
    if (!lexicalNode) return;

    const tableCellNode = $getTableCellNodeFromLexicalNode(lexicalNode);
    if (tableCellNode) {
      let candidate: LexicalNode | null = lexicalNode;
      while (candidate) {
        if (candidate.is(tableCellNode)) {
          break;
        }

        const parent: LexicalNode | null = candidate.getParent();
        if (parent?.is(tableCellNode)) {
          insertionTarget = { kind: 'after-node', nodeKey: candidate.getKey() };
          return;
        }

        if (!parent || !$isElementNode(parent)) {
          break;
        }
        candidate = parent;
      }

      const lastChild = tableCellNode.getLastChild();
      insertionTarget = lastChild
        ? { kind: 'after-node', nodeKey: lastChild.getKey() }
        : { kind: 'append-to-cell', cellKey: tableCellNode.getKey() };
      return;
    }

    // Walk up to find the top-level block node (direct child of root)
    const root = $getRoot();
    while (lexicalNode) {
      const parent: LexicalNode | null = lexicalNode.getParent();
      if (parent && parent.is(root)) {
        insertionTarget = { kind: 'after-node', nodeKey: lexicalNode.getKey() };
        return;
      }
      if (!parent || !$isElementNode(parent)) {
        break;
      }
      lexicalNode = parent;
    }
  });

  return insertionTarget;
}

// ── Drop indicator ──────────────────────────────────────────────────────────

type DropIndicatorTarget =
  | { kind: 'root'; targetElement: HTMLElement | null }
  | {
      kind: 'table-cell';
      cellElement: HTMLTableCellElement;
      targetElement: HTMLElement | null;
    };

function closestTableCell(
  node: Node,
  rootElement: HTMLElement
): HTMLTableCellElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const cell = element?.closest('td,th');
  if (!(cell instanceof HTMLTableCellElement) || !rootElement.contains(cell)) {
    return null;
  }
  return cell;
}

function directChildElementWithin(parent: HTMLElement, node: Node): HTMLElement | null {
  let current: Node | null = node instanceof Element ? node : node.parentNode;
  while (current && current !== parent) {
    if (current.parentNode === parent && current instanceof HTMLElement) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * Resolve the nearest top-level block DOM element at the drag position.
 * Pure DOM — no Lexical API. Safe to call on every dragover tick.
 */
function resolveDropIndicatorTarget(
  event: DragEvent,
  rootElement: HTMLElement
): DropIndicatorTarget {
  const range = getCaretRangeFromPoint(event.clientX, event.clientY);
  if (!range) return { kind: 'root', targetElement: null };

  let node: Node | null = range.startContainer;
  const cellElement = closestTableCell(node, rootElement);
  if (cellElement) {
    return {
      kind: 'table-cell',
      cellElement,
      targetElement: directChildElementWithin(cellElement, node)
    };
  }

  while (node && node !== rootElement) {
    if (node.parentNode === rootElement && node instanceof HTMLElement) {
      return { kind: 'root', targetElement: node };
    }
    node = node.parentNode;
  }
  return { kind: 'root', targetElement: null };
}

function createDropIndicator(): HTMLElement {
  const el = document.createElement('div');
  el.dataset.mossMediaDropIndicator = 'true';
  el.style.cssText =
    `position:absolute;height:2px;background:${EDITOR_CHROME_COLORS.imageDropIndicator};border-radius:1px;pointer-events:none;z-index:10;transition:top 60ms ease-out,opacity 120ms;opacity:0;`;
  const label = document.createElement('span');
  label.textContent = 'Drop media';
  label.style.cssText =
    `position:absolute;left:50%;top:-10px;transform:translateX(-50%);font-size:10px;line-height:1;color:${EDITOR_CHROME_COLORS.imageDropIndicator};background:${EDITOR_CHROME_COLORS.imageDropLabelBackground};padding:1px 6px;border-radius:4px;border:1px solid ${EDITOR_CHROME_COLORS.imageDropIndicator};white-space:nowrap;`;
  el.appendChild(label);
  return el;
}

interface DropIndicatorState {
  element: HTMLElement;
  scrollContainer: HTMLElement | null;
  lastTargetEl: HTMLElement | null;
  lastCellEl: HTMLTableCellElement | null;
  lastKind: DropIndicatorTarget['kind'] | null;
}

function showDropIndicator(
  state: DropIndicatorState,
  target: DropIndicatorTarget,
  rootElement: HTMLElement
): void {
  const scrollContainer = state.scrollContainer
    ?? (rootElement.closest('.canvas-scroll') as HTMLElement | null);
  state.scrollContainer = scrollContainer;
  if (!scrollContainer) return;

  const indicator = state.element;

  // Append to scroll container (not contentEditable)
  if (indicator.parentElement !== scrollContainer) {
    scrollContainer.appendChild(indicator);
  }

  // Skip redundant reposition if same target
  const cellElement = target.kind === 'table-cell' ? target.cellElement : null;
  if (
    target.targetElement === state.lastTargetEl &&
    cellElement === state.lastCellEl &&
    target.kind === state.lastKind &&
    indicator.style.opacity === '1'
  ) {
    return;
  }
  state.lastTargetEl = target.targetElement;
  state.lastCellEl = cellElement;
  state.lastKind = target.kind;

  const scrollRect = scrollContainer.getBoundingClientRect();
  const rootRect = rootElement.getBoundingClientRect();

  if (target.kind === 'table-cell') {
    const cellRect = target.cellElement.getBoundingClientRect();
    const cellStyle = window.getComputedStyle(target.cellElement);
    const paddingLeft = Number.parseFloat(cellStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(cellStyle.paddingRight) || 0;
    const paddingTop = Number.parseFloat(cellStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(cellStyle.paddingBottom) || 0;
    const minTop = cellRect.top - scrollRect.top + scrollContainer.scrollTop + paddingTop;
    const maxTop = Math.max(
      minTop,
      cellRect.bottom - scrollRect.top + scrollContainer.scrollTop - paddingBottom
    );
    const targetRect = target.targetElement?.getBoundingClientRect();
    const desiredTop = targetRect
      ? targetRect.bottom - scrollRect.top + scrollContainer.scrollTop + 2
      : minTop;

    indicator.style.left = `${cellRect.left - scrollRect.left + paddingLeft}px`;
    indicator.style.right = 'auto';
    indicator.style.width = `${Math.max(24, cellRect.width - paddingLeft - paddingRight)}px`;
    indicator.style.top = `${Math.min(maxTop, Math.max(minTop, desiredTop))}px`;
    indicator.style.opacity = '1';
    return;
  }

  // Match the editor content width (not the full scroll container)
  indicator.style.left = `${rootRect.left - scrollRect.left}px`;
  indicator.style.right = `${scrollRect.right - rootRect.right}px`;
  indicator.style.width = '';

  if (target.targetElement) {
    const rect = target.targetElement.getBoundingClientRect();
    indicator.style.top = `${rect.bottom - scrollRect.top + scrollContainer.scrollTop + 2}px`;
  } else {
    // End of document — position after last child of editor root
    const lastChild = rootElement.lastElementChild;
    if (lastChild) {
      const rect = lastChild.getBoundingClientRect();
      indicator.style.top = `${rect.bottom - scrollRect.top + scrollContainer.scrollTop + 4}px`;
    } else {
      indicator.style.top = `${rootRect.top - scrollRect.top + scrollContainer.scrollTop + 8}px`;
    }
  }

  indicator.style.opacity = '1';
}

function hideIndicator(state: DropIndicatorState): void {
  state.element.style.opacity = '0';
  state.lastTargetEl = null;
  state.lastCellEl = null;
  state.lastKind = null;
}

function removeIndicator(state: DropIndicatorState): void {
  state.element.remove();
  state.lastTargetEl = null;
  state.lastCellEl = null;
  state.lastKind = null;
  state.scrollContainer = null;
}

/**
 * Insert a media node at the resolved drop position, or at the end of the document as fallback.
 */
function $insertMediaAtPosition(
  mediaNode: LexicalNode,
  insertionTarget: DropInsertionTarget | null
): void {
  if (insertionTarget) {
    const targetNode = $getNodeByKey(
      insertionTarget.kind === 'after-node'
        ? insertionTarget.nodeKey
        : insertionTarget.cellKey
    );
    if (insertionTarget.kind === 'after-node' && targetNode) {
      targetNode.insertAfter(mediaNode);
      return;
    }
    if (insertionTarget.kind === 'append-to-cell' && $isTableCellNode(targetNode)) {
      targetNode.append(mediaNode);
      return;
    }
  }
  // Fallback: insert at end of document
  const root = $getRoot();
  const lastChild = root.getLastChild();
  if (lastChild) {
    lastChild.insertAfter(mediaNode);
  } else {
    $insertNodes([mediaNode]);
  }
}

/**
 * Check if dataTransfer contains media-droppable content
 */
function hasMediaContent(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const types = dataTransfer.types;
  return (
    types.includes('Files') ||
    types.includes('text/uri-list') ||
    types.includes('text/plain') ||
    types.includes('text/html')
  );
}

type MountedRef = {
  current: boolean;
};

export function registerMediaDrop(
  editor: LexicalEditor,
  noteId: string,
  mountedRef: MountedRef
): () => void {
  const indicatorState: DropIndicatorState = {
    element: createDropIndicator(),
    scrollContainer: null,
    lastTargetEl: null,
    lastCellEl: null,
    lastKind: null
  };

  // Handle dragover to allow drops and show indicator
  const unregisterDragOver = editor.registerCommand(
    DRAGOVER_COMMAND,
    (event) => {
      if (hasMediaContent(event.dataTransfer)) {
        event.preventDefault();
        // Only show indicator for file drags (not text/url drags)
        const rootElement = editor.getRootElement();
        if (rootElement && event.dataTransfer?.types.includes('Files')) {
          const target = resolveDropIndicatorTarget(event, rootElement);
          showDropIndicator(indicatorState, target, rootElement);
        }
        return true;
      }
      return false;
    },
    COMMAND_PRIORITY_HIGH
  );

  // Hide indicator when drag leaves the editor or window
  let rootElement: HTMLElement | null = null;
  try { rootElement = editor.getRootElement(); } catch { /* headless mode */ }
  const handleDragLeave = (e: DragEvent) => {
    let root: HTMLElement | null = null;
    try { root = editor.getRootElement(); } catch { /* headless mode */ }
    // relatedTarget is null when leaving the window
    if (!e.relatedTarget || (root && e.relatedTarget instanceof Node && !root.contains(e.relatedTarget))) {
      hideIndicator(indicatorState);
    }
  };
  rootElement?.addEventListener('dragleave', handleDragLeave);

  // Handle the actual drop
  const unregisterDrop = editor.registerCommand(
    DROP_COMMAND,
    (event) => {
      hideIndicator(indicatorState);
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return false;

      // Resolve the drop position to a Lexical node BEFORE preventDefault
      // (caretRangeFromPoint needs the event coordinates to be valid)
      const dropTarget = resolveDropInsertionTarget(event, editor);

      // === LOCAL FILE HANDLING (check FIRST - most common case) ===
      const mediaFiles = dataTransfer.files?.length
        ? Array.from(dataTransfer.files).filter((file) => isImageFile(file) || isVideoFile(file))
        : [];

      if (mediaFiles.length > 0) {
        event.preventDefault();
        // moss-multi seam: hide-registry (A§9): uploads land in M3; until then a dropped file is refused visibly
        if (hidden('media-upload')) {
          refuseInput(MEDIA_UPLOAD_REFUSED);
          return true;
        }
        const droppedLocalMediaReferences = dataTransfer.types.includes('text/uri-list')
          ? parseLocalMediaReferencesFromUriList(dataTransfer.getData('text/uri-list'))
          : [];
        const plainTextLocalReference = dataTransfer.types.includes('text/plain')
          ? parseLocalMediaReference(dataTransfer.getData('text/plain'))
          : null;

        // Process files async
        (async () => {
          for (const file of mediaFiles) {
            try {
              if (isVideoFile(file)) {
                let filePath = (file as File & { path?: string }).path ?? null;
                if (!filePath) {
                  const matchedReference = droppedLocalMediaReferences.find(
                    (reference) => reference.filename === file.name
                  );
                  filePath = matchedReference?.filePath
                    ?? (mediaFiles.length === 1
                      ? droppedLocalMediaReferences[0]?.filePath ?? plainTextLocalReference?.filePath ?? null
                      : plainTextLocalReference?.filename === file.name
                        ? plainTextLocalReference.filePath
                        : null);
                }

                let result: { relativePath: string };
                if (filePath) {
                  result = await imagesApi.copyFromPath.invoke({
                    filePath,
                    filename: file.name,
                    noteId
                  });
                } else {
                  // Fallback: read file as base64 when filesystem path unavailable
                  const base64Data = await readFileAsBase64(file);
                  const mimeType = file.type || VIDEO_EXT_TO_MIME[getExt(file.name)] || 'video/mp4';
                  result = await imagesApi.save.invoke({
                    data: base64Data,
                    filename: file.name,
                    mimeType,
                    noteId
                  });
                }

                if (!mountedRef.current) return;

                editor.update(() => {
                  const videoNode = $createVideoNode(result.relativePath, file.name);
                  $insertMediaAtPosition(videoNode, dropTarget);
                });
                continue;
              }

              const base64Data = await readFileAsBase64(file);
              const result = await imagesApi.save.invoke({
                data: base64Data,
                filename: file.name,
                mimeType: getImageMimeType(file),
                noteId
              });

              if (!mountedRef.current) return;

              editor.update(() => {
                const imageNode = $createImageNode(result.relativePath, file.name);
                $insertMediaAtPosition(imageNode, dropTarget);
              });
            } catch (error) {
              console.error('[MediaDropPlugin] Failed to process dropped media:', error);
            }
          }
        })();

        return true;
      }

      // === EXTERNAL URL HANDLING ===
      let url: string | null = null;

      // 1. Try text/uri-list first (standard for URI drags)
      if (dataTransfer.types.includes('text/uri-list')) {
        const uriList = dataTransfer.getData('text/uri-list');
        url = extractUrlFromUriList(uriList);
      }

      // 2. Fallback to text/plain
      if (!url && dataTransfer.types.includes('text/plain')) {
        const plainText = dataTransfer.getData('text/plain')?.trim();
        if (plainText) {
          url = plainText;
        }
      }

      // 3. Try extracting from text/html
      if (!url && dataTransfer.types.includes('text/html')) {
        const html = dataTransfer.getData('text/html');
        const srcMatch = html?.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (srcMatch?.[1]) {
          url = srcMatch[1];
        }
      }

      if (url) {
        const localMedia = parseLocalMediaReference(url);
        if (localMedia) {
          event.preventDefault();

          void imagesApi.copyFromPath.invoke({
            noteId,
            filePath: localMedia.filePath,
            filename: localMedia.filename
          }).then((saved) => {
            if (!saved || !mountedRef.current) {
              return;
            }

            editor.update(() => {
              const mediaNode = getExt(localMedia.filename) in VIDEO_EXT_TO_MIME
                ? $createVideoNode(saved.relativePath, localMedia.filename)
                : $createImageNode(saved.relativePath, localMedia.filename);
              $insertMediaAtPosition(mediaNode, dropTarget);
            });
          }).catch((error) => {
            console.error('[MediaDropPlugin] Failed to localize dropped media file:', error);
          });

          return true;
        }
      }

      if (url && isYouTubeUrl(url)) {
        event.preventDefault();

        editor.update(() => {
          const videoNode = $createVideoNode(url, isYouTubeUrl(url) ? 'YouTube video' : extractAltFromUrl(url));
          $insertMediaAtPosition(videoNode, dropTarget);
        });

        return true;
      }

      if (url && isHttpsImageUrl(url)) {
        event.preventDefault();

        const capturedUrl = url;
        const filenameHint = capturedUrl.split('/').pop()?.split('?')[0];

        void preflightRemoteImageUrl({
          noteId,
          url: capturedUrl,
          filenameHint
        }).then((saved) => {
          if (!saved || !mountedRef.current) {
            return;
          }

          editor.update(() => {
            const imageNode = $createImageNode(saved.relativePath, extractAltFromUrl(capturedUrl));
            $insertMediaAtPosition(imageNode, dropTarget);
          });
        });

        return true;
      }

      return false;
    },
    COMMAND_PRIORITY_HIGH
  );

  return () => {
    unregisterDragOver();
    unregisterDrop();
    rootElement?.removeEventListener('dragleave', handleDragLeave);
    removeIndicator(indicatorState);
  };
}

/**
 * MediaDropPlugin - Handles drag and drop of media files into the editor
 *
 * Uses Lexical's DROP_COMMAND to properly integrate with the editor's event system.
 * When a user drags local media into the editor:
 * 1. Images use the existing base64 save flow
 * 2. Videos use copyFromPath so large files never go through base64
 * 3. Local paths and YouTube URL drops resolve to the right node type
 */
export function MediaDropPlugin({ noteId }: { noteId: string }): null {
  const [editor] = useLexicalComposerContext();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return registerMediaDrop(editor, noteId, mountedRef);
  }, [editor, noteId]);

  return null;
}
