// ported-from: packages/desktop/src/renderer/editor/plugins/ExternalImagePastePlugin.tsx @ 762abb777
/**
 * ExternalImagePastePlugin
 *
 * Detects when users paste HTTPS image URLs and automatically converts them
 * to ImageNode elements instead of plain text. Also handles cross-note asset
 * paste via moss-asset:// URLs from the HTML clipboard.
 *
 * Same-note paste is handled by Lexical's default importDOM pipeline:
 * exportDOM emits moss-asset:// URLs → $convertImageElement → fromDisplaySrc()
 * strips them back to relative paths. All content is preserved.
 *
 * Security: Only HTTPS URLs are accepted (no HTTP) to ensure secure loading.
 * Detection: Uses extension-based matching (.png, .jpg, etc.) for reliability.
 */
import { useEffect } from 'react';

import { $insertGeneratedNodes } from '@lexical/clipboard';
import { $generateNodesFromDOM } from '@lexical/html';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { objectKlassEquals } from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_NORMAL,
  PASTE_COMMAND,
  type LexicalEditor
} from 'lexical';

import { imagesApi } from '../../api/electron';
import { $createImageNode } from '../nodes/ImageNode';
import {
  extractAltFromUrl,
  isHttpsImageUrl,
  preflightRemoteImageUrl
} from '../utils/remote-image-url';
import { useCurrentNoteId } from '../CurrentNoteIdContext';
// moss-multi seam: web-assets (A§16)
import { webAssetsInHtml } from '@moss-multi/host/media/web-asset-url';
import { $holdInsertionPoint, type HeldInsertionPoint } from '@moss-multi/host/media/held-insertion';

const CROSS_NOTE_ASSET_PASTE_CONCURRENCY = 2;

// moss-multi seam: held-insertion (A§16): a replayed range deleted text typed during the copy; a held point follows it
function captureRangeSelection(): HeldInsertionPoint | null {
  return $holdInsertionPoint();
}

function restoreRangeSelection(saved: HeldInsertionPoint): boolean {
  return saved.$restore();
}

type MossAssetInfo = {
  url: string;
  noteId: string;
  filename: string;
  relativePath: string;
};

function parseMossAssetUrl(url: string): MossAssetInfo | null {
  if (!url.startsWith('moss-asset://')) {
    return null;
  }

  const withoutProtocol = url.slice('moss-asset://'.length);
  const queryIndex = withoutProtocol.indexOf('?');
  const encodedPath = queryIndex >= 0 ? withoutProtocol.slice(0, queryIndex) : withoutProtocol;
  const queryString = queryIndex >= 0 ? withoutProtocol.slice(queryIndex + 1) : '';

  const params = new URLSearchParams(queryString);
  const noteId = params.get('noteId')?.trim() ?? '';
  if (!noteId) return null;

  const relativePath = decodeURIComponent(encodedPath);
  const filename = relativePath.split('/').pop() ?? '';
  if (!filename || filename.includes('..') || filename.includes('\\')) return null;

  return { url, noteId, filename, relativePath };
}

/** Extract ALL moss-asset:// URLs from HTML clipboard data (across any attribute). */
function extractAllMossAssetsFromHtml(html: string): MossAssetInfo[] {
  const results: MossAssetInfo[] = [];
  const seenUrls = new Set<string>();
  const regex = /moss-asset:\/\/[^"'\s>]+/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const fullUrl = match[0];
    if (seenUrls.has(fullUrl)) {
      continue;
    }

    const parsed = parseMossAssetUrl(fullUrl);
    if (!parsed) {
      continue;
    }

    seenUrls.add(fullUrl);
    results.push(parsed);
  }
  // moss-multi seam: web-assets (A§16): on the web a copied note's media is an asset route URL naming its note
  for (const asset of webAssetsInHtml(html)) {
    if (!seenUrls.has(asset.url)) {
      seenUrls.add(asset.url);
      results.push(asset);
    }
  }
  return results;
}

/** Extract external HTTPS image URLs from <img> tags in HTML clipboard data. */
function extractExternalImageUrlsFromHtml(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = doc.querySelectorAll('img[src]');
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('https://') && !src.startsWith('moss-asset://') && !seen.has(src)) {
      seen.add(src);
      urls.push(src);
    }
  }
  return urls;
}

/** Check if a path looks like a local asset reference */
function isLocalAssetPath(path: string): boolean {
  return path.startsWith('assets/') && !path.includes('://');
}

/** Validate that a filename is safe (no path traversal) */
function isSafeFilename(name: string): boolean {
  return Boolean(name) && !name.includes('/') && !name.includes('\\') && !name.includes('..');
}

function isPersistableLocalAssetPath(path: string | null | undefined): path is string {
  const normalized = path?.trim() ?? '';
  const segments = normalized.split('/');
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !normalized.startsWith('\\') &&
    !normalized.includes('\\') &&
    !/^[a-z][a-z\d+.-]*:/i.test(normalized) &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function removeUnresolvedMossAssetReferences(
  dom: Document,
  unresolvedUrls: ReadonlySet<string>
): void {
  if (unresolvedUrls.size === 0) {
    return;
  }

  for (const element of Array.from(dom.body.querySelectorAll('*'))) {
    let removeElement = false;
    for (const attribute of Array.from(element.attributes)) {
      const containsUnresolvedUrl = Array.from(unresolvedUrls).some((url) =>
        attribute.value.includes(url)
      );
      if (!containsUnresolvedUrl) {
        continue;
      }

      if (attribute.name === 'src' || attribute.name === 'data-video-src') {
        removeElement = true;
        break;
      }
      element.removeAttribute(attribute.name);
    }

    if (removeElement) {
      element.remove();
    }
  }
}

async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (!item) {
        continue;
      }
      await worker(item);
    }
  });

  await Promise.all(workers);
}

/**
 * Register the external image paste handler
 */
export function registerExternalImagePaste(editor: LexicalEditor, noteId: string | null): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      // Only handle ClipboardEvents
      const isClipboardEvent =
        typeof ClipboardEvent !== 'undefined'
          ? objectKlassEquals(event, ClipboardEvent)
          : event && typeof event === 'object' && 'clipboardData' in event;

      if (!isClipboardEvent) {
        return false;
      }

      const clipboardData = (event as ClipboardEvent).clipboardData;
      if (!clipboardData) {
        return false;
      }

      // Get plain text from clipboard
      const plainText = clipboardData.getData('text/plain')?.trim() ?? '';

      // Check HTML clipboard for cross-note moss-asset:// references
      const html = clipboardData.getData('text/html') ?? '';
      const allMossAssets = extractAllMossAssetsFromHtml(html);
      const crossNoteAssets = noteId ? allMossAssets.filter(a => a.noteId !== noteId) : [];

      // Cross-note paste: copy assets to destination note, rewrite HTML, insert all content
      if (crossNoteAssets.length > 0 && noteId) {
        event.preventDefault();
        event.stopPropagation();

        const insertionPoint = captureRangeSelection();
        if (!insertionPoint) return true;

        void (async () => {
          try {
            // Copy all cross-note assets to destination in parallel
            const urlMapping = new Map<string, string>();

            await processWithConcurrency(crossNoteAssets, CROSS_NOTE_ASSET_PASTE_CONCURRENCY, async (asset) => {
              try {
                const result = await imagesApi.copyFromNoteAsset.invoke({
                  sourceNoteId: asset.noteId,
                  sourceRelativePath: asset.relativePath,
                  destinationNoteId: noteId,
                  filename: asset.filename
                });

                if (isPersistableLocalAssetPath(result?.relativePath)) {
                  urlMapping.set(asset.url, result.relativePath.trim());
                }
              } catch (err) {
                console.warn('[ExternalImagePastePlugin] Failed to copy cross-note asset:', asset.filename, err);
              }
            });

            // Rewrite HTML, replacing cross-note moss-asset URLs with local paths
            let rewrittenHtml = html;
            for (const [oldUrl, newPath] of urlMapping) {
              rewrittenHtml = rewrittenHtml.split(oldUrl).join(newPath);
            }

            // Parse rewritten HTML and insert all content (text + images)
            const dom = new DOMParser().parseFromString(rewrittenHtml, 'text/html');
            const unresolvedUrls = new Set(
              crossNoteAssets
                .filter((asset) => !urlMapping.has(asset.url))
                .map((asset) => asset.url)
            );
            removeUnresolvedMossAssetReferences(dom, unresolvedUrls);

            editor.update(() => {
              restoreRangeSelection(insertionPoint);
              const selection = $getSelection();
              if (!selection) return;

              const nodes = $generateNodesFromDOM(editor, dom);
              $insertGeneratedNodes(editor, nodes, selection);
            });
          } catch (err) {
            console.warn('[ExternalImagePastePlugin] Cross-note paste failed:', err);
          } finally {
            insertionPoint.release();
          }
        })();

        return true;
      }

      // HTML clipboard contains external <img> tags (e.g., from Notion, web pages)
      // Download the images and rewrite the HTML before letting Lexical process it
      const externalImageUrls = html ? extractExternalImageUrlsFromHtml(html) : [];
      if (externalImageUrls.length > 0 && noteId) {
        event.preventDefault();
        event.stopPropagation();

        const insertionPoint = captureRangeSelection();
        if (!insertionPoint) return true;

        void (async () => {
          try {
            const urlMapping = new Map<string, string>();

            await processWithConcurrency(externalImageUrls, CROSS_NOTE_ASSET_PASTE_CONCURRENCY, async (url) => {
              try {
                const filenameHint = new URL(url).pathname.split('/').pop()?.split('?')[0];
                const result = await preflightRemoteImageUrl({
                  noteId,
                  url,
                  filenameHint,
                  skipUrlCheck: true
                });
                if (result?.relativePath) {
                  urlMapping.set(url, result.relativePath);
                }
              } catch (err) {
                console.warn('[ExternalImagePastePlugin] Failed to persist external image:', url, err);
              }
            });

            // Rewrite HTML, replacing external URLs with local asset paths
            let rewrittenHtml = html;
            for (const [oldUrl, newPath] of urlMapping) {
              rewrittenHtml = rewrittenHtml.split(oldUrl).join(newPath);
            }

            const dom = new DOMParser().parseFromString(rewrittenHtml, 'text/html');

            editor.update(() => {
              restoreRangeSelection(insertionPoint);
              const selection = $getSelection();
              if (!selection) return;

              const nodes = $generateNodesFromDOM(editor, dom);
              $insertGeneratedNodes(editor, nodes, selection);
            });
          } catch (err) {
            console.warn('[ExternalImagePastePlugin] External image paste failed:', err);
          } finally {
            insertionPoint.release();
          }
        })();

        return true;
      }

      // Skip local asset paths pasted as text (let normal paste handle them)
      if (isLocalAssetPath(plainText)) {
        return false;
      }

      // Check if it's an HTTPS image URL
      if (!plainText || !isHttpsImageUrl(plainText)) {
        return false;
      }

      if (!noteId) {
        return false;
      }

      const insertionPoint = captureRangeSelection();
      if (!insertionPoint) {
        return false;
      }

      // Prevent default paste behavior
      event.preventDefault();
      event.stopPropagation();

      const pastedUrl = plainText;
      const filenameHint = pastedUrl.split('/').pop()?.split('?')[0];

      void preflightRemoteImageUrl({
        noteId,
        url: pastedUrl,
        filenameHint
      }).then((saved) => {
        if (!saved) {
          return;
        }

        editor.update(() => {
          restoreRangeSelection(insertionPoint);
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }

          const imageNode = $createImageNode(saved.relativePath, extractAltFromUrl(pastedUrl));
          selection.insertNodes([imageNode]);
        });
      }).finally(() => insertionPoint.release());

      return true;
    },
    COMMAND_PRIORITY_NORMAL
  );
}

/**
 * Plugin that auto-converts pasted HTTPS image URLs to ImageNodes
 */
export function ExternalImagePastePlugin(): null {
  const [editor] = useLexicalComposerContext();
  const noteId = useCurrentNoteId();

  useEffect(() => {
    return registerExternalImagePaste(editor, noteId);
  }, [editor, noteId]);

  return null;
}

export const externalImagePasteTestUtils = {
  extractAllMossAssetsFromHtml,
  extractExternalImageUrlsFromHtml,
  isLocalAssetPath,
  isSafeFilename,
  isPersistableLocalAssetPath,
  removeUnresolvedMossAssetReferences
};
