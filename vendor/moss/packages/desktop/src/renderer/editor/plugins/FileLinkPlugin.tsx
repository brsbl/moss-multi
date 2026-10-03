// ported-from: packages/desktop/src/renderer/editor/plugins/FileLinkPlugin.tsx @ 762abb777
// moss-multi seam: access-dependent resolution is local paint, never a tree write.
import { $isBoundEditor, setNodeView } from '@moss-multi/host/collab/view-state';
import { useEffect, useCallback, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  COMMAND_PRIORITY_LOW,
  KEY_DOWN_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type LexicalEditor
} from 'lexical';
import { $isHeadingNode } from '@lexical/rich-text';
import { AlertCircle, Calendar, Columns2, ExternalLink, Folder } from 'lucide-react';

import { linkResolutionAtom, buildLinkResolutionCacheKey, mapNoteMetadataToNoteEntity, openSplitTabAtom, pendingScrollTargetAtom, showCommandPaletteAtom, type LinkResolutionCacheEntry } from '@moss/shared/state/atoms';
import { noteEntityAtom, noteIdsAtom } from '@moss/shared/state/note-atoms';
import { noteListEntityAtom } from '@moss/shared';
import type { NoteEntity } from '@moss/shared/types/note-entity';
import type { LinkResolutionState, NoteMetadataRecord } from '../../../common/noteTypes';
import { $isFileLinkNode, type FileLinkNode } from '../nodes/FileLinkNode';
import { disassembleNote } from '../../../common/markdown-layers';
import { stripWikiLinks } from '../../../common/utils';
import { useDecoratorBackspace } from '../hooks';
import { useCurrentNoteId } from '../CurrentNoteIdContext';
import { externalNotesApi, notesApi, systemApi } from '../../api/electron';
import {
  EDITOR_UPDATE_TAGS,
  runIgnoredEditorUpdate,
} from '../utils/editorUpdateTags';
import { useInlinePillHoverPreview } from './useInlinePillHoverPreview';

const RICH_PREVIEW_HIDE_DELAY_MS = 80;

/**
 * Detect whether a wiki-link target looks like a relative/absolute file path
 * rather than a plain note title.
 */
function isPathLikeTarget(target: string): boolean {
  return target.startsWith('./') || target.startsWith('../') || target.includes('/');
}

function normalizeHeadingForMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function toHeadingSlug(value: string): string {
  return normalizeHeadingForMatch(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Browser-safe path resolution (no Node.js `path` module).
 * Resolves `relative` against `base` (which is treated as a file path —
 * the last segment is dropped to get the directory).
 */
function browserResolvePath(base: string, relative: string): string {
  const baseParts = base.split('/').filter(Boolean);
  const relParts = relative.split('/').filter(Boolean);
  // Start from the directory containing the base file (drop last segment)
  const result = [...baseParts.slice(0, -1)];
  for (const part of relParts) {
    if (part === '..') result.pop();
    else if (part !== '.') result.push(part);
  }
  return '/' + result.join('/');
}

/**
 * Resolve a path-like link target against an external note's file path.
 * Searches registered external notes whose `externalFilePath` matches
 * the resolved absolute path (with or without common markdown extensions).
 *
 * Returns a resolved `LinkResolutionCacheEntry` if found, or an unresolved
 * entry otherwise.
 */
function resolvePathLikeExternalTarget(
  target: string,
  sourceEntity: NoteEntity,
  store: ReturnType<typeof useStore>
): LinkResolutionCacheEntry {
  const externalFilePath = sourceEntity.externalFilePath;
  const externalRootPath = sourceEntity.externalRootPath;
  if (!externalFilePath || !externalRootPath) {
    return { noteId: null, noteTitle: target, isResolved: false };
  }

  const resolved = browserResolvePath(externalFilePath, target);

  // Security: ensure the resolved path stays within the external root
  const normalizedRoot = externalRootPath.endsWith('/')
    ? externalRootPath
    : externalRootPath + '/';
  if (!resolved.startsWith(normalizedRoot) && resolved !== externalRootPath) {
    return { noteId: null, noteTitle: target, isResolved: false };
  }

  // Candidate paths: exact, with .md, with .markdown
  const candidates: string[] = [resolved];
  if (!/\.\w+$/.test(resolved)) {
    candidates.push(resolved + '.md', resolved + '.markdown');
  }

  const noteIds = store.get(noteIdsAtom);
  for (const noteId of noteIds) {
    const entity = store.get(noteEntityAtom(noteId));
    if (!entity || !entity.externalFilePath) continue;
    for (const candidate of candidates) {
      if (entity.externalFilePath === candidate) {
        return {
          noteId: entity.id,
          noteTitle: entity.title,
          isResolved: true,
          updatedAt: entity.updatedAt,
          folderPath: entity.folderPath
        };
      }
    }
  }

  return { noteId: null, noteTitle: target, isResolved: false };
}

/**
 * Browser-safe dirname — returns the parent path of a file path.
 */
function browserDirname(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return '/' + parts.slice(0, -1).join('/');
}

/**
 * Browser-safe basename — returns the last segment of a path, optionally without extension.
 */
function browserBasename(filePath: string, stripExt = false): string {
  const parts = filePath.split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  if (stripExt) {
    const dotIndex = name.lastIndexOf('.');
    return dotIndex > 0 ? name.slice(0, dotIndex) : name;
  }
  return name;
}

/**
 * Normalizes a filename stem for fuzzy wiki-link matching:
 * strips numeric prefix (e.g. "02-"), replaces hyphens/underscores with spaces.
 */
function normalizeFilenameStem(stem: string): string {
  return stem
    .replace(/^\d+-/, '')
    .replace(/[-_]/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Fallback resolver for external sibling files.
 * When a wiki link like [[Use Cases]] doesn't match any note title directly,
 * this checks sibling external files in the same root directory by normalizing
 * their filenames (strip numeric prefix, replace hyphens/underscores with spaces).
 */
function resolveExternalSiblingByFilename(
  noteTitle: string,
  sourceEntity: NoteEntity,
  store: ReturnType<typeof useStore>
): LinkResolutionCacheEntry {
  const sourceRoot = sourceEntity.externalRootPath || browserDirname(sourceEntity.externalFilePath!);
  const normalizedTarget = noteTitle.trim().toLowerCase();
  const noteIds = store.get(noteIdsAtom);

  for (const noteId of noteIds) {
    const entity = store.get(noteEntityAtom(noteId));
    if (!entity?.externalFilePath) continue;

    // Only match sibling files under the same external root
    const entityRoot = entity.externalRootPath || browserDirname(entity.externalFilePath);
    if (entityRoot !== sourceRoot) continue;

    const stem = browserBasename(entity.externalFilePath, true);
    const normalizedStem = normalizeFilenameStem(stem);

    if (normalizedStem === normalizedTarget) {
      return {
        noteId: entity.id,
        noteTitle: entity.title,
        isResolved: true,
        updatedAt: entity.updatedAt,
        folderPath: entity.folderPath
      };
    }
  }

  return { noteId: null, noteTitle, isResolved: false };
}

/**
 * Resolves a note by title using client-side atom lookup.
 * Searches through all loaded notes for a case-insensitive title match.
 */
function resolveNoteByTitleFromAtoms(
  noteTitle: string,
  store: ReturnType<typeof useStore>
): LinkResolutionCacheEntry {
  const normalizedTitle = noteTitle.trim().toLowerCase();
  const noteIds = store.get(noteIdsAtom);

  for (const noteId of noteIds) {
    const entity = store.get(noteEntityAtom(noteId));
    if (entity && entity.title.toLowerCase() === normalizedTitle) {
      // Found a matching note
      // For preview, we don't have content in atoms - that's OK, it's optional
      return {
        noteId: entity.id,
        noteTitle: entity.title,
        isResolved: true,
        updatedAt: entity.updatedAt,
        folderPath: entity.folderPath
      };
    }
  }

  // Note not found
  return {
    noteId: null,
    noteTitle,
    isResolved: false
  };
}

/**
 * Helper to get cached result from atom or resolve and cache.
 * Uses Jotai store for proper state management integration.
 * Resolves via client-side atom lookup instead of IPC.
 *
 * Cache strategy:
 * - Only cache resolved results (unresolved may be transient - notes not loaded yet)
 * - Validate cached results against current note state (note may have been renamed/deleted)
 */
function resolveAndCache(
  noteTitle: string,
  store: ReturnType<typeof useStore>,
  sourceEntity?: NoteEntity | null
): LinkResolutionCacheEntry {
  const sourceContext = sourceEntity?.externalFilePath;
  const cacheKey = buildLinkResolutionCacheKey(noteTitle, sourceContext);

  // Check atom cache first
  const cached = store.get(linkResolutionAtom(cacheKey));
  if (cached && cached.isResolved && cached.noteId) {
    // Validate cached result is still valid (note wasn't deleted/renamed)
    const noteIds = store.get(noteIdsAtom);
    if (noteIds.has(cached.noteId)) {
      const entity = store.get(noteEntityAtom(cached.noteId));
      if (entity) {
        // For path-based resolution, validate the external file path still matches
        // For title-based, validate the title still matches
        if (sourceEntity?.externalFilePath && isPathLikeTarget(noteTitle)) {
          if (entity.externalFilePath) return cached;
        } else if (entity.title.toLowerCase() === noteTitle.trim().toLowerCase()) {
          return cached;
        } else {
          // Note was renamed — return resolution with new title so the link can update
          const renamedResult: LinkResolutionCacheEntry = {
            noteId: cached.noteId,
            noteTitle: entity.title,
            isResolved: true,
            updatedAt: entity.updatedAt,
            folderPath: entity.folderPath,
          };
          // Migrate cache to new key
          store.set(linkResolutionAtom(cacheKey), null);
          const newCacheKey = buildLinkResolutionCacheKey(entity.title, sourceContext);
          store.set(linkResolutionAtom(newCacheKey), renamedResult);
          return renamedResult;
        }
      }
    }
    // Cached entry is stale (note deleted), clear it
    store.set(linkResolutionAtom(cacheKey), null);
  }

  // Path-like target in an external note: resolve by path
  let result: LinkResolutionCacheEntry;
  if (sourceEntity?.externalFilePath && isPathLikeTarget(noteTitle)) {
    result = resolvePathLikeExternalTarget(noteTitle, sourceEntity, store);
  } else {
    // Resolve via client-side atom lookup (synchronous, no IPC)
    result = resolveNoteByTitleFromAtoms(noteTitle, store);
  }

  // Fallback: filename-based resolution for external sibling files
  if (!result.isResolved && sourceEntity?.externalFilePath) {
    result = resolveExternalSiblingByFilename(noteTitle, sourceEntity, store);
  }

  // Only cache resolved results - unresolved may be due to notes not yet loaded
  if (result.isResolved) {
    store.set(linkResolutionAtom(cacheKey), result);
  }

  return result;
}

/**
 * Resolve the destination note id for a file link, or null when there is no
 * target note to open (e.g. a same-note heading anchor, which has a heading but
 * no note title). Used for Cmd/Ctrl-click "open in new window".
 */
function resolveFileLinkTargetNoteId(
  fields: { noteId: string | null; noteTitle: string },
  store: ReturnType<typeof useStore>,
  sourceEntity?: NoteEntity | null
): string | null {
  if (fields.noteId) {
    return fields.noteId;
  }
  if (!fields.noteTitle) {
    return null;
  }
  return resolveAndCache(fields.noteTitle, store, sourceEntity).noteId;
}

/**
 * Async fallback for external-note wiki links. When a target can't be resolved
 * against already-registered note entities, ask the main process to locate a
 * matching sibling markdown file on disk under the same external root and
 * register it. On success the new note is hydrated into the renderer atoms and
 * the link-resolution cache so the link behaves like any other resolved link.
 *
 * Returns a resolved entry, or null when the source is not an external note or
 * no sibling file matches.
 */
async function resolveExternalSiblingViaIpc(
  noteTitle: string,
  sourceEntity: NoteEntity | null | undefined,
  store: ReturnType<typeof useStore>
): Promise<LinkResolutionCacheEntry | null> {
  const sourceContext = sourceEntity?.externalFilePath;
  if (!sourceContext || !noteTitle) {
    return null;
  }

  let record: NoteMetadataRecord | null;
  try {
    record = await externalNotesApi.resolveLink.invoke(sourceEntity!.id, noteTitle);
  } catch (error) {
    console.warn('[FileLinkPlugin] Failed to resolve external sibling link:', error);
    return null;
  }
  if (!record) {
    return null;
  }

  const entity = mapNoteMetadataToNoteEntity(record);
  store.set(noteEntityAtom(entity.id), entity);
  store.set(noteIdsAtom, (prev) => {
    if (prev.has(entity.id)) {
      return prev;
    }
    const next = new Set(prev);
    next.add(entity.id);
    return next;
  });

  const resolved: LinkResolutionCacheEntry = {
    noteId: entity.id,
    noteTitle: entity.title,
    isResolved: true,
    updatedAt: entity.updatedAt,
    folderPath: entity.folderPath
  };
  store.set(linkResolutionAtom(buildLinkResolutionCacheKey(noteTitle, sourceContext)), resolved);
  return resolved;
}

/**
 * Mark a FileLinkNode as resolved in the editor without dirtying the note.
 * Used after async external-sibling resolution so the pill reflects the match.
 */
function setFileLinkResolvedInEditor(
  editor: LexicalEditor,
  nodeKey: string,
  resolved: LinkResolutionCacheEntry
): void {
  runIgnoredEditorUpdate(editor, () => {
    const node = $getNodeByKey(nodeKey);
    if ($isFileLinkNode(node)) {
      $setLinkView(node, { noteId: resolved.noteId, isResolved: resolved.isResolved });
      if (resolved.isResolved) {
        $setLinkView(node, { resolutionState: 'note_resolved' });
        if (resolved.noteTitle && node.getNoteTitle() !== resolved.noteTitle) {
          $setLinkView(node, { noteTitle: resolved.noteTitle });
        }
      }
    }
  }, EDITOR_UPDATE_TAGS.ignored.skipDirty);
}

/**
 * Scrolls to a heading in the editor by traversing Lexical nodes.
 * Uses case-insensitive, trimmed comparison for matching.
 *
 * Note: We only traverse top-level children because HeadingNode extends ElementNode
 * and cannot be nested inside other elements in Lexical's rich-text model.
 * If nested headings are ever supported in the future, use $dfs() traversal instead.
 *
 * @returns boolean indicating if heading was found and scrolled to
 */
export function scrollToHeading(editor: LexicalEditor, headingText: string): boolean {
  const normalizedTarget = normalizeHeadingForMatch(headingText);
  const targetSlug = toHeadingSlug(headingText);
  let found = false;
  editor.getEditorState().read(() => {
    const root = $getRoot();
    for (const child of root.getChildren()) {
      if ($isHeadingNode(child)) {
        const nodeText = stripWikiLinks(child.getTextContent());
        const normalizedNodeText = normalizeHeadingForMatch(nodeText);
        const nodeSlug = toHeadingSlug(nodeText);
        if (
          normalizedNodeText === normalizedTarget ||
          (targetSlug.length > 0 && nodeSlug === targetSlug)
        ) {
          const element = editor.getElementByKey(child.getKey());
          if (!element) {
            // Heading exists in editor state but DOM isn't mounted yet.
            // Let callers retry on the next update.
            continue;
          }
          const scrollToElementWithOffset = () => {
            const editorRoot = editor.getRootElement();
            const scrollContainer = editorRoot?.closest('.canvas-scroll');

            if (scrollContainer instanceof HTMLElement) {
              const containerRect = scrollContainer.getBoundingClientRect();
              const HEADING_SCROLL_GAP_PX = 4;
              let desiredHeadingTopInViewport = containerRect.top + HEADING_SCROLL_GAP_PX;

              const floatingOverlay = scrollContainer.querySelector('[data-floating-title-overlay="true"]');
              if (floatingOverlay instanceof HTMLElement) {
                const overlayStyle = window.getComputedStyle(floatingOverlay);
                const overlayOpacity = Number.parseFloat(overlayStyle.opacity || '1');
                if (overlayStyle.visibility !== 'hidden' && overlayOpacity > 0.01) {
                  const floatingBarRow = scrollContainer.querySelector(
                    '[data-floating-title-bar-row="true"]'
                  );
                  const offsetElement =
                    floatingBarRow instanceof HTMLElement ? floatingBarRow : floatingOverlay;
                  const offsetRect = offsetElement.getBoundingClientRect();
                  const offsetBottomInViewport = Math.min(containerRect.bottom, offsetRect.bottom);
                  if (offsetBottomInViewport > containerRect.top) {
                    desiredHeadingTopInViewport = offsetBottomInViewport + HEADING_SCROLL_GAP_PX;
                  }
                }
              }

              const headingRect = element.getBoundingClientRect();
              const delta = headingRect.top - desiredHeadingTopInViewport;
              if (Math.abs(delta) > 1) {
                scrollContainer.scrollTo({
                  top: Math.max(0, scrollContainer.scrollTop + delta),
                  behavior: 'auto'
                });
              }
            } else {
              element.scrollIntoView({ behavior: 'auto', block: 'start' });
            }
          };

          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                scrollToElementWithOffset();
              });
            });
          } else {
            scrollToElementWithOffset();
          }
          found = true;
          break;
        }
      }
    }
  });
  return found;
}

/**
 * Shared handler for file link activation (click or Enter key).
 * Handles same-note anchors, cross-note anchors, and regular wiki links.
 * For unresolved links, resolves synchronously via atom lookup before navigating.
 *
 * Returns true when the activation was handled (scrolled or navigated), false
 * when the link could not be resolved synchronously. A false return lets callers
 * fall back to the async external-sibling resolver for external notes.
 */
function handleFileLinkActivation(
  node: FileLinkNode,
  nodeKey: string,
  editor: LexicalEditor,
  store: ReturnType<typeof useStore>,
  navigate: (id: string, heading?: string | null) => void,
  sourceEntity?: NoteEntity | null
): boolean {
  const headingText = node.getHeadingText();
  const noteTitle = node.getNoteTitle();
  let noteId = node.getNoteId();

  // Same-note anchor: headingText present AND noteTitle is empty
  if (headingText && !noteTitle) {
    if (!scrollToHeading(editor, headingText)) {
      return false;
    }
    if (sourceEntity?.id) {
      navigate(sourceEntity.id, headingText);
    }
    return true;
  }

  // If not resolved, resolve lazily now (synchronous atom lookup)
  if (!node.isResolved() && noteTitle) {
    const result = resolveAndCache(noteTitle, store, sourceEntity);
    noteId = result.noteId;

    // Update the node with resolved data. For external notes an unresolved
    // result may still resolve via the async on-disk sibling resolver, so leave
    // the pill untouched (don't flash a broken state) and let the caller retry.
    const isExternalSource = Boolean(sourceEntity?.externalFilePath);
    editor.update(() => {
      const currentNode = $getNodeByKey(nodeKey);
      if ($isFileLinkNode(currentNode)) {
        if (result.isResolved) {
          $setLinkView(currentNode, { noteId: result.noteId, isResolved: result.isResolved });
          $setLinkView(currentNode, { resolutionState: 'note_resolved' });
        } else if (!isExternalSource) {
          $setLinkView(currentNode, { noteId: result.noteId, isResolved: result.isResolved });
          $setLinkView(currentNode, { resolutionState: 'not_found' });
        }
      }
    });

    if (!result.isResolved) {
      // Note doesn't exist in registered entities — caller may retry on disk.
      return false;
    }
  }

  // Sync link title if the target note was renamed
  if (noteId && noteTitle) {
    const entity = store.get(noteEntityAtom(noteId));
    if (entity && entity.title !== noteTitle) {
      const newTitle = entity.title;
      editor.update(() => {
        const currentNode = $getNodeByKey(nodeKey);
        if ($isFileLinkNode(currentNode)) {
          $setLinkView(currentNode, { noteTitle: newTitle });
        }
      });
      // Update cache with new key
      const sourceContext = sourceEntity?.externalFilePath;
      const oldCacheKey = buildLinkResolutionCacheKey(noteTitle, sourceContext);
      const newCacheKey = buildLinkResolutionCacheKey(newTitle, sourceContext);
      store.set(linkResolutionAtom(oldCacheKey), null);
      store.set(linkResolutionAtom(newCacheKey), {
        noteId,
        noteTitle: newTitle,
        isResolved: true,
        updatedAt: entity.updatedAt,
        folderPath: entity.folderPath,
      });
    }
  }

  // Cross-note anchor: both headingText and noteId are present
  if (headingText && noteId) {
    // Set scroll target before navigation
    store.set(pendingScrollTargetAtom, { noteId, heading: headingText });
    navigate(noteId, headingText);
    return true;
  }

  // Regular wiki link: navigate to note
  if (noteId) {
    navigate(noteId);
    return true;
  }

  return false;
}

interface PreviewState {
  isVisible: boolean;
  nodeKey: string | null;
  position: { x: number; y: number };
  noteTitle: string;
  noteId: string | null;
  isResolved: boolean;
  preview?: string;
  updatedAt?: number;
  folderPath?: string;
  unresolvedLabel?: string;
}

interface FileLinkPreviewData {
  noteTitle: string;
  headingText: string | null;
  resolutionState: LinkResolutionState;
}

const initialPreviewState: PreviewState = {
  isVisible: false,
  nodeKey: null,
  position: { x: 0, y: 0 },
  noteTitle: '',
  noteId: null,
  isResolved: false
};

const FILE_LINK_PREVIEW_CARD_ATTRIBUTE = 'data-file-link-preview-card';
const FILE_LINK_PREVIEW_CARD_SELECTOR = `[${FILE_LINK_PREVIEW_CARD_ATTRIBUTE}]`;
const FILE_LINK_NODE_SELECTOR = '[data-file-link-node-key]';

function isElementInsideSelector(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && Boolean(target.closest(selector));
}

function isFileLinkPreviewTarget(target: EventTarget | null): boolean {
  return isElementInsideSelector(target, FILE_LINK_PREVIEW_CARD_SELECTOR);
}

function isFileLinkOrPreviewTarget(target: EventTarget | null): boolean {
  return (
    isElementInsideSelector(target, FILE_LINK_NODE_SELECTOR) ||
    isFileLinkPreviewTarget(target)
  );
}

const FILE_LINK_PREVIEW_TEXT_LIMIT = 220;

function stripMarkdownForPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, '$1')
    .replace(/<u>([\s\S]*?)<\/u>/gi, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[|*_~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getHeadingTextFromMarkdownLine(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    text: stripMarkdownForPreview(stripWikiLinks(match[2]))
  };
}

function extractHeadingSectionMarkdown(body: string, headingText: string | null): string {
  const cleanHeading = headingText ? stripWikiLinks(headingText).trim() : '';
  if (!cleanHeading) {
    return body;
  }

  const normalizedTarget = normalizeHeadingForMatch(cleanHeading);
  const targetSlug = toHeadingSlug(cleanHeading);
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let startIndex = -1;
  let startLevel = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const heading = getHeadingTextFromMarkdownLine(lines[index]);
    if (!heading) {
      continue;
    }

    const normalizedHeading = normalizeHeadingForMatch(heading.text);
    const headingSlug = toHeadingSlug(heading.text);
    if (
      normalizedHeading === normalizedTarget ||
      (targetSlug.length > 0 && headingSlug === targetSlug)
    ) {
      startIndex = index;
      startLevel = heading.level;
      break;
    }
  }

  if (startIndex < 0) {
    return body;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const heading = getHeadingTextFromMarkdownLine(lines[index]);
    if (heading && heading.level <= startLevel) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex + 1, endIndex).join('\n');
}

function buildPreviewTextFromMarkdown(rawMarkdown: string, headingText: string | null): string | undefined {
  const { body } = disassembleNote(rawMarkdown);
  const previewMarkdown = extractHeadingSectionMarkdown(body, headingText);
  const preview = stripMarkdownForPreview(previewMarkdown);
  return preview.length > 0 ? preview.slice(0, FILE_LINK_PREVIEW_TEXT_LIMIT) : undefined;
}

function buildPreviewCacheKey(noteId: string, headingText: string | null): string {
  return `${noteId}::${headingText ?? ''}`;
}

function buildSameNoteHeadingPreviewLoadState(
  currentNoteId: string | null,
  headingText: string | null,
  isResolved: boolean
): { noteId: string; headingText: string; previewCacheKey: string } | null {
  const cleanHeading = headingText ? stripWikiLinks(headingText).trim() : '';
  if (!currentNoteId || !cleanHeading || !isResolved) {
    return null;
  }

  return {
    noteId: currentNoteId,
    headingText: cleanHeading,
    previewCacheKey: buildPreviewCacheKey(currentNoteId, cleanHeading)
  };
}

async function loadFileLinkPreviewText(noteId: string, headingText: string | null): Promise<string | undefined> {
  const result = await notesApi.getContent.invoke(noteId, { contentReadMode: 'raw' });
  if (!result?.content) {
    return undefined;
  }

  return buildPreviewTextFromMarkdown(result.content, headingText);
}

function buildSameNoteHeadingPreviewState(
  headingText: string | null,
  resolutionState: LinkResolutionState,
  position: PreviewState['position'],
  nodeKey: string | null = null
): PreviewState | null {
  const cleanHeading = headingText ? stripWikiLinks(headingText).trim() : '';
  if (!cleanHeading) {
    return null;
  }

  const isMissing = resolutionState === 'heading_not_found' || resolutionState === 'not_found';
  return {
    isVisible: true,
    nodeKey,
    position,
    noteTitle: cleanHeading,
    noteId: null,
    isResolved: !isMissing,
    unresolvedLabel: 'Heading not found'
  };
}

interface FileLinkPreviewProps {
  state: PreviewState;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function FileLinkPreview({ state, onMouseEnter, onMouseLeave }: FileLinkPreviewProps) {
  if (!state.isVisible) {
    return null;
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  return createPortal(
    <div
      {...{ [FILE_LINK_PREVIEW_CARD_ATTRIBUTE]: 'true' }}
      className="fixed z-50 max-w-xs rounded-lg border border-border-subtle bg-surface-floating p-3 shadow-lg animate-in fade-in-0 zoom-in-95"
      style={{
        left: state.position.x,
        top: state.position.y
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-start gap-2">
        {!state.isResolved && (
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-status-error-text-submitted" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium text-ink-default">{state.noteTitle}</p>
          </div>
          {state.isResolved ? (
            <>
              {(state.folderPath || state.updatedAt) && (
                <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-ink-muted">
                  {state.folderPath && (
                    <span className="flex min-w-0 items-center gap-1">
                      <Folder className="h-3 w-3 flex-shrink-0 text-ink-muted" aria-hidden />
                      <span className="truncate">{state.folderPath}</span>
                    </span>
                  )}
                  {state.updatedAt && (
                    <span className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap">
                      <Calendar className="h-3 w-3" aria-hidden />
                      <span>Updated {formatDate(state.updatedAt)}</span>
                    </span>
                  )}
                </div>
              )}
              {state.preview && (
                <p className="mt-2 line-clamp-3 text-xs text-ink-muted">{state.preview}</p>
              )}
            </>
          ) : (
            <p className="mt-1 text-xs text-status-error-text-submitted">
              {state.unresolvedLabel ?? 'Note not found'}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

interface FileLinkContextMenuState {
  isVisible: boolean;
  position: { x: number; y: number };
  noteId: string;
}

const initialContextMenuState: FileLinkContextMenuState = {
  isVisible: false,
  position: { x: 0, y: 0 },
  noteId: ''
};

function FileLinkContextMenu({
  state,
  onOpenInNewWindow,
  onOpenSplitTab,
  onClose
}: {
  state: FileLinkContextMenuState;
  onOpenInNewWindow: (noteId: string) => void;
  onOpenSplitTab: (noteId: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.isVisible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [state.isVisible, onClose]);

  if (!state.isVisible) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-32 overflow-hidden rounded-lg border border-border-subtle bg-surface-canvas p-1 text-ink-default shadow-lg animate-in fade-in-0 zoom-in-95"
      style={{
        left: state.position.x,
        top: state.position.y,
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
    >
      <button
        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-accent-brand/10 hover:text-accent-brand-pressed"
        onClick={() => {
          onOpenInNewWindow(state.noteId);
          onClose();
        }}
      >
        <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
        <span>Open in New Window</span>
      </button>
      <div className="my-1 h-px bg-border-subtle" />
      <button
        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-accent-brand/10 hover:text-accent-brand-pressed"
        onClick={() => {
          onOpenSplitTab(state.noteId);
          onClose();
        }}
      >
        <Columns2 className="h-3.5 w-3.5 text-ink-muted" />
        <span>Open in Split Tab</span>
      </button>
    </div>,
    document.body
  );
}

interface FileLinkPluginProps {
  onNavigateToNote?: (noteId: string, heading?: string | null) => void;
}

export function FileLinkPlugin({ onNavigateToNote }: FileLinkPluginProps) {
  const [editor] = useLexicalComposerContext();
  const store = useStore();
  const noteList = useAtomValue(noteListEntityAtom);
  const showCommandPalette = useAtomValue(showCommandPaletteAtom);
  const currentNoteId = useCurrentNoteId();
  const openSplitTab = useSetAtom(openSplitTabAtom);
  const [previewState, setPreviewState] = useState<PreviewState>(initialPreviewState);
  const [contextMenuState, setContextMenuState] = useState<FileLinkContextMenuState>(initialContextMenuState);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activePreviewNodeKeyRef = useRef<string | null>(null);
  const previewLoadGenerationRef = useRef(0);
  const pluginMountedRef = useRef(true);
  const previewTextCacheRef = useRef<Map<string, string>>(new Map());

  const invalidatePreviewLoads = useCallback(() => {
    previewLoadGenerationRef.current += 1;
  }, []);

  const isPreviewLoadCurrent = useCallback((generation: number, nodeKey: string) => (
    pluginMountedRef.current &&
    previewLoadGenerationRef.current === generation &&
    activePreviewNodeKeyRef.current === nodeKey
  ), []);

  useEffect(() => {
    pluginMountedRef.current = true;
    return () => {
      pluginMountedRef.current = false;
      activePreviewNodeKeyRef.current = null;
      invalidatePreviewLoads();
    };
  }, [invalidatePreviewLoads]);

  const clearHoverTimeout = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const cancelHidePreview = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const handleOpenInNewWindow = useCallback((noteId: string) => {
    void systemApi.createWindow.invoke({ noteId }).catch((error) => {
      console.warn('[FileLinkPlugin] Failed to open note in new window:', error);
    });
  }, []);

  const hidePreview = useCallback(() => {
    clearHoverTimeout();
    cancelHidePreview();
    activePreviewNodeKeyRef.current = null;
    invalidatePreviewLoads();
    hideTimeoutRef.current = setTimeout(() => {
      setPreviewState(initialPreviewState);
      hideTimeoutRef.current = null;
    }, RICH_PREVIEW_HIDE_DELAY_MS);
  }, [clearHoverTimeout, cancelHidePreview, invalidatePreviewLoads]);

  const dismissPreview = useCallback(() => {
    clearHoverTimeout();
    cancelHidePreview();
    activePreviewNodeKeyRef.current = null;
    invalidatePreviewLoads();
    setPreviewState(initialPreviewState);
  }, [clearHoverTimeout, cancelHidePreview, invalidatePreviewLoads]);

  const showPreview = useCallback(
    async (element: HTMLElement, nodeKey: string) => {
      clearHoverTimeout();
      cancelHidePreview();
      activePreviewNodeKeyRef.current = nodeKey;
      const previewLoadGeneration = previewLoadGenerationRef.current + 1;
      previewLoadGenerationRef.current = previewLoadGeneration;

      const linkData = editor.getEditorState().read((): FileLinkPreviewData | null => {
        const node = $getNodeByKey(nodeKey);
        if ($isFileLinkNode(node)) {
          return {
            noteTitle: node.getNoteTitle(),
            headingText: node.getHeadingText(),
            resolutionState: node.getResolutionState()
          };
        }
        return null;
      });

      if (!linkData) {
        activePreviewNodeKeyRef.current = null;
        return;
      }

      const noteTitle = linkData.noteTitle;
      const headingText = linkData.headingText;
      const resolutionState = linkData.resolutionState;
      if (!noteTitle) {
        if (headingText) {
          hoverTimeoutRef.current = setTimeout(() => {
            if (!isPreviewLoadCurrent(previewLoadGeneration, nodeKey)) {
              return;
            }

            let latestHeadingText: string | null = headingText;
            let latestResolutionState = resolutionState;
            editor.getEditorState().read(() => {
              const node = $getNodeByKey(nodeKey);
              if ($isFileLinkNode(node)) {
                latestHeadingText = node.getHeadingText();
                latestResolutionState = node.getResolutionState();
              }
            });
            const rect = element.getBoundingClientRect();
            const sameNotePreview = buildSameNoteHeadingPreviewState(
              latestHeadingText,
              latestResolutionState,
              {
                x: rect.left,
                y: rect.bottom + 8
              },
              nodeKey
            );
            if (sameNotePreview) {
              const previewLoadState = buildSameNoteHeadingPreviewLoadState(
                currentNoteId,
                latestHeadingText,
                sameNotePreview.isResolved
              );
              const cachedPreview = previewLoadState
                ? previewTextCacheRef.current.get(previewLoadState.previewCacheKey)
                : undefined;
              setPreviewState({
                ...sameNotePreview,
                preview: cachedPreview
              });

              if (previewLoadState && !cachedPreview) {
                void loadFileLinkPreviewText(previewLoadState.noteId, previewLoadState.headingText)
                  .then((previewText) => {
                    if (!previewText || !isPreviewLoadCurrent(previewLoadGeneration, nodeKey)) {
                      return;
                    }

                    previewTextCacheRef.current.set(previewLoadState.previewCacheKey, previewText);
                    setPreviewState((current) => (
                      current.isVisible && current.nodeKey === nodeKey
                        ? { ...current, preview: previewText }
                        : current
                    ));
                  })
                  .catch((error) => {
                    console.warn('[FileLinkPlugin] Failed to load same-note heading preview:', error);
                  });
              }
            }
          }, 300);
        }
        return;
      }

      // Delay before showing preview to avoid flicker on fast mouse movements
      hoverTimeoutRef.current = setTimeout(() => {
        if (!isPreviewLoadCurrent(previewLoadGeneration, nodeKey)) {
          return;
        }

        // Get the current note's entity for path-aware resolution
        const sourceEntity = currentNoteId ? store.get(noteEntityAtom(currentNoteId)) : null;
        const sourceContext = sourceEntity?.externalFilePath;
        const cacheKey = buildLinkResolutionCacheKey(noteTitle, sourceContext);

        // Check atom cache first
        const cached = store.get(linkResolutionAtom(cacheKey));
        const result = cached ?? resolveAndCache(noteTitle, store, sourceEntity);

        const rect = element.getBoundingClientRect();
        const previewCacheKey = result.noteId
          ? buildPreviewCacheKey(result.noteId, headingText)
          : null;
        const cachedPreview = previewCacheKey
          ? previewTextCacheRef.current.get(previewCacheKey)
          : undefined;
        setPreviewState({
          isVisible: true,
          nodeKey,
          position: {
            x: rect.left,
            y: rect.bottom + 8
          },
          noteTitle: result.noteTitle,
          noteId: result.noteId,
          isResolved: result.isResolved,
          preview: cachedPreview ?? result.preview,
          updatedAt: result.updatedAt,
          folderPath: result.folderPath
        });

        if (result.isResolved && result.noteId && previewCacheKey && !cachedPreview) {
          void loadFileLinkPreviewText(result.noteId, headingText)
            .then((previewText) => {
              if (!previewText || !isPreviewLoadCurrent(previewLoadGeneration, nodeKey)) {
                return;
              }

              previewTextCacheRef.current.set(previewCacheKey, previewText);
              setPreviewState((current) => (
                current.isVisible && current.nodeKey === nodeKey
                  ? { ...current, preview: previewText }
                  : current
              ));
            })
            .catch((error) => {
              console.warn('[FileLinkPlugin] Failed to load note preview:', error);
            });
        }

        // Update the node's resolved state and title in the editor
        const needsTitleSync = result.isResolved && result.noteTitle !== noteTitle;
        const isExternalSource = Boolean(sourceContext);
        if (!cached || needsTitleSync) {
          runIgnoredEditorUpdate(editor, () => {
            const node = $getNodeByKey(nodeKey);
            if ($isFileLinkNode(node)) {
              if (result.isResolved) {
                $setLinkView(node, { noteId: result.noteId, isResolved: result.isResolved });
                $setLinkView(node, { resolutionState: 'note_resolved' });
                // Sync title if the target note was renamed
                if (needsTitleSync) {
                  $setLinkView(node, { noteTitle: result.noteTitle });
                }
              } else if (!isExternalSource) {
                // External siblings may still resolve on disk below — don't flash
                // a broken state for them while the async lookup runs.
                $setLinkView(node, { noteId: result.noteId, isResolved: result.isResolved });
                $setLinkView(node, { resolutionState: 'not_found' });
              }
            }
          }, EDITOR_UPDATE_TAGS.ignored.skipDirty);
        }

        // External note: when the target isn't a registered entity, look for a
        // matching sibling file on disk and update the preview once resolved.
        if (!result.isResolved && isExternalSource) {
          void resolveExternalSiblingViaIpc(noteTitle, sourceEntity, store).then((resolved) => {
            if (!resolved?.noteId || !isPreviewLoadCurrent(previewLoadGeneration, nodeKey)) {
              return;
            }
            setFileLinkResolvedInEditor(editor, nodeKey, resolved);
            setPreviewState((current) => (
              current.isVisible && current.nodeKey === nodeKey
                ? {
                    ...current,
                    noteTitle: resolved.noteTitle,
                    noteId: resolved.noteId,
                    isResolved: true,
                    updatedAt: resolved.updatedAt,
                    folderPath: resolved.folderPath
                  }
                : current
            ));
          });
        }
      }, 300);
    },
    [editor, clearHoverTimeout, cancelHidePreview, isPreviewLoadCurrent, store, currentNoteId]
  );

  const handleNavigate = useCallback(
    (noteId: string, heading?: string | null) => {
      dismissPreview();
      if (onNavigateToNote) {
        onNavigateToNote(noteId, heading);
      }
    },
    [dismissPreview, onNavigateToNote]
  );

  useEffect(() => {
    dismissPreview();
  }, [currentNoteId, dismissPreview]);

  useEffect(() => {
    if (showCommandPalette) {
      dismissPreview();
    }
  }, [showCommandPalette, dismissPreview]);

  useEffect(() => {
    if (!previewState.isVisible) {
      return;
    }

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!isFileLinkOrPreviewTarget(event.target)) {
        dismissPreview();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isFileLinkOrPreviewTarget(event.target)) {
        dismissPreview();
      }
    };

    const handleScroll = () => {
      dismissPreview();
    };

    const handleWindowBlur = () => {
      dismissPreview();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        dismissPreview();
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('scroll', handleScroll, true);
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const unregisterSelectionDismiss = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        dismissPreview();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );

    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unregisterSelectionDismiss();
    };
  }, [editor, previewState.isVisible, dismissPreview]);

  // Handle mouse events on file link elements
  useEffect(() => {
    if (noteList.length === 0) {
      return;
    }

    // In visual-snapshot mode, FileLink titles are pre-resolved in the
    // fixture markdown — skip any in-renderer resolution sweep so captures
    // are deterministic regardless of note-list hydration timing.
    if (
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-moss-snapshot') === 'true'
    ) {
      return;
    }

    const sourceEntity = currentNoteId ? store.get(noteEntityAtom(currentNoteId)) : null;
    const updates: Array<{
      nodeKey: string;
      noteId: string | null;
      isResolved: boolean;
      noteTitle?: string;
      resolutionState?: LinkResolutionState;
    }> = [];

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const visit = (node: import('lexical').LexicalNode): void => {
        if ($isFileLinkNode(node)) {
          const nodeKey = node.getKey();
          const headingText = node.getHeadingText();
          const noteTitle = node.getNoteTitle();
          const noteId = node.getNoteId();

          // Skip same-note heading anchors.
          if (headingText && !noteTitle) {
            return;
          }

          if (noteId) {
            const entity = store.get(noteEntityAtom(noteId));
            if (!entity) {
              return;
            }
            const nextState: (typeof updates)[number] = {
              nodeKey,
              noteId: entity.id,
              isResolved: true
            };
            if (entity.title !== noteTitle) {
              nextState.noteTitle = entity.title;
            }
            if (!node.isResolved()) {
              nextState.resolutionState = 'note_resolved';
            }
            if (nextState.noteTitle || nextState.resolutionState) {
              updates.push(nextState);
            }
            return;
          }

          if (!noteTitle || node.isResolved()) {
            return;
          }

          const result = resolveAndCache(noteTitle, store, sourceEntity);
          if (!result.isResolved) {
            return;
          }

          updates.push({
            nodeKey,
            noteId: result.noteId,
            isResolved: true,
            noteTitle: result.noteTitle,
            resolutionState: 'note_resolved'
          });
          return;
        }

        if ('getChildren' in node && typeof node.getChildren === 'function') {
          for (const child of node.getChildren()) {
            visit(child);
          }
        }
      };

      for (const child of root.getChildren()) {
        visit(child);
      }
    });

    if (updates.length === 0) {
      return;
    }

    runIgnoredEditorUpdate(editor, () => {
      for (const update of updates) {
        const node = $getNodeByKey(update.nodeKey);
        if (!$isFileLinkNode(node)) {
          continue;
        }
        $setLinkView(node, { noteId: update.noteId, isResolved: update.isResolved });
        if (update.noteTitle) {
          $setLinkView(node, { noteTitle: update.noteTitle });
        }
        if (update.resolutionState) {
          $setLinkView(node, { resolutionState: update.resolutionState });
        }
      }
    }, EDITOR_UPDATE_TAGS.ignored.skipDirty);
  }, [currentNoteId, editor, noteList, store]);

  const handleHoverShow = useCallback(
    ({ element, nodeKey }: { element: HTMLElement; nodeKey: string }) => {
      void showPreview(element, nodeKey);
    },
    [showPreview]
  );

  const handleHoverHide = useCallback(() => {
    hidePreview();
  }, [hidePreview]);

  // Note/wiki file-link pills keep whole-pill hover at the existing 300 ms delay,
  // using the same shared primitive the webpage embed pills use.
  useInlinePillHoverPreview({
    editor,
    nodeKeyAttribute: 'data-file-link-node-key',
    showDelayMs: 300,
    hideDelayMs: RICH_PREVIEW_HIDE_DELAY_MS,
    onShow: handleHoverShow,
    onHide: handleHoverHide
  });

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const fileLinkElement = target.closest(FILE_LINK_NODE_SELECTOR) as HTMLElement | null;

      if (fileLinkElement) {
        event.preventDefault();
        event.stopPropagation();
        dismissPreview();

        const nodeKey = fileLinkElement.getAttribute('data-file-link-node-key');
        if (nodeKey) {
          // Get node synchronously, then handle activation async.
          // Separate primitive variables satisfy TypeScript narrowing (the
          // node is assigned inside the read callback closure).
          let node: FileLinkNode | null = null;
          let linkNoteId: string | null = null;
          let linkNoteTitle = '';
          let linkHeadingText: string | null = null;
          editor.getEditorState().read(() => {
            const foundNode = $getNodeByKey(nodeKey);
            if ($isFileLinkNode(foundNode)) {
              node = foundNode;
              linkNoteId = foundNode.getNoteId();
              linkNoteTitle = foundNode.getNoteTitle();
              linkHeadingText = foundNode.getHeadingText();
            }
          });
          if (node) {
            const sourceEntity = currentNoteId ? store.get(noteEntityAtom(currentNoteId)) : null;
            const isExternalSource = Boolean(sourceEntity?.externalFilePath);

            // Cmd/Ctrl-click opens the target note in a new window instead of
            // navigating in place. Same-note heading anchors have no target
            // note, so they fall through to normal activation (scroll).
            if (event.metaKey || event.ctrlKey) {
              const targetNoteId = resolveFileLinkTargetNoteId(
                { noteId: linkNoteId, noteTitle: linkNoteTitle },
                store,
                sourceEntity
              );
              if (targetNoteId) {
                handleOpenInNewWindow(targetNoteId);
                return;
              }
              // External notes: the sibling may exist on disk but not yet be
              // registered — resolve it asynchronously, then open the window.
              if (isExternalSource && linkNoteTitle) {
                void resolveExternalSiblingViaIpc(linkNoteTitle, sourceEntity, store).then((resolved) => {
                  if (resolved?.noteId) {
                    setFileLinkResolvedInEditor(editor, nodeKey, resolved);
                    handleOpenInNewWindow(resolved.noteId);
                  }
                });
                return;
              }
            }

            const handled = handleFileLinkActivation(node, nodeKey, editor, store, handleNavigate, sourceEntity);
            // Plain-click fallback for external notes whose sibling target is on
            // disk but not yet registered as a note entity.
            if (!handled && isExternalSource && linkNoteTitle) {
              const heading = linkHeadingText;
              void resolveExternalSiblingViaIpc(linkNoteTitle, sourceEntity, store).then((resolved) => {
                if (resolved?.noteId) {
                  setFileLinkResolvedInEditor(editor, nodeKey, resolved);
                  if (heading) {
                    store.set(pendingScrollTargetAtom, { noteId: resolved.noteId, heading });
                  }
                  handleNavigate(resolved.noteId, heading);
                }
              });
            }
          }
        }
      }
    };

    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const fileLinkElement = target.closest(FILE_LINK_NODE_SELECTOR) as HTMLElement | null;
      if (!fileLinkElement) return;

      const nodeKey = fileLinkElement.getAttribute('data-file-link-node-key');
      if (!nodeKey) return;

      // Resolve the note ID so we can open it in split tab
      let resolvedNoteId: string | null = null;
      let unresolvedExternalTitle = '';
      const sourceEntity = currentNoteId ? store.get(noteEntityAtom(currentNoteId)) : null;
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isFileLinkNode(node)) {
          resolvedNoteId = node.getNoteId();
          // If not resolved yet, try to resolve
          if (!resolvedNoteId && node.getNoteTitle()) {
            const result = resolveAndCache(node.getNoteTitle(), store, sourceEntity);
            resolvedNoteId = result.noteId;
            if (!resolvedNoteId && sourceEntity?.externalFilePath) {
              unresolvedExternalTitle = node.getNoteTitle();
            }
          }
        }
      });

      // Only show context menu for resolved links with a note ID
      if (!resolvedNoteId) {
        if (!unresolvedExternalTitle || !sourceEntity?.externalFilePath) return;

        event.preventDefault();
        event.stopPropagation();
        dismissPreview();

        const position = { x: event.clientX, y: event.clientY };
        void resolveExternalSiblingViaIpc(unresolvedExternalTitle, sourceEntity, store).then((resolved) => {
          if (!resolved?.noteId) return;
          setFileLinkResolvedInEditor(editor, nodeKey, resolved);
          setContextMenuState({
            isVisible: true,
            position,
            noteId: resolved.noteId
          });
        });
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      // Hide hover preview when showing context menu.
      dismissPreview();

      setContextMenuState({
        isVisible: true,
        position: { x: event.clientX, y: event.clientY },
        noteId: resolvedNoteId
      });
    };

    rootElement.addEventListener('click', handleClick);
    rootElement.addEventListener('contextmenu', handleContextMenu);

    return () => {
      rootElement.removeEventListener('click', handleClick);
      rootElement.removeEventListener('contextmenu', handleContextMenu);
      activePreviewNodeKeyRef.current = null;
      invalidatePreviewLoads();
      clearHoverTimeout();
      cancelHidePreview();
    };
  }, [editor, handleNavigate, handleOpenInNewWindow, clearHoverTimeout, cancelHidePreview, invalidatePreviewLoads, dismissPreview, store, currentNoteId]);

  // Handle Enter key on file links for keyboard navigation
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key !== 'Enter') {
          return false;
        }

        // Extract node data from editor state
        // Use separate variables to satisfy TypeScript narrowing
        let foundNode: FileLinkNode | null = null;
        let foundKey: string | null = null;
        let foundTitle = '';
        let foundHeading: string | null = null;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          if ($isNodeSelection(sel)) {
            const nodes = sel.getNodes();
            if (nodes.length === 1 && $isFileLinkNode(nodes[0])) {
              foundNode = nodes[0];
              foundKey = nodes[0].getKey();
              foundTitle = nodes[0].getNoteTitle();
              foundHeading = nodes[0].getHeadingText();
            }
          }
        });

        if (foundNode && foundKey) {
          event.preventDefault();
          dismissPreview();
          const sourceEntity = currentNoteId ? store.get(noteEntityAtom(currentNoteId)) : null;
          const handled = handleFileLinkActivation(foundNode, foundKey, editor, store, handleNavigate, sourceEntity);
          if (!handled && sourceEntity?.externalFilePath && foundTitle) {
            const targetKey = foundKey;
            const heading = foundHeading;
            void resolveExternalSiblingViaIpc(foundTitle, sourceEntity, store).then((resolved) => {
              if (resolved?.noteId) {
                setFileLinkResolvedInEditor(editor, targetKey, resolved);
                if (heading) {
                  store.set(pendingScrollTargetAtom, { noteId: resolved.noteId, heading });
                }
                handleNavigate(resolved.noteId, heading);
              }
            });
          }
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, handleNavigate, dismissPreview, store, currentNoteId]);

  // Validate same-note anchors on load (these can be validated synchronously without IPC)
  // Cross-note links are resolved lazily on hover/click for performance
  useEffect(() => {
    // Collect current editor headings for same-note anchor validation
    const editorHeadings = new Set<string>();
    editor.getEditorState().read(() => {
      const root = $getRoot();
      for (const child of root.getChildren()) {
        if ($isHeadingNode(child)) {
          const text = stripWikiLinks(child.getTextContent()).trim().toLowerCase();
          if (text) editorHeadings.add(text);
        }
      }
    });

    // Collect same-note anchors that need validation
    const sameNoteAnchors: { nodeKey: string; headingText: string }[] = [];
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const collectSameNoteAnchors = (node: ReturnType<typeof $getRoot>) => {
        for (const child of node.getChildren()) {
          if ($isFileLinkNode(child)) {
            const headingText = child.getHeadingText();
            const noteTitle = child.getNoteTitle();
            // Same-note anchor: has heading but no note title
            if (headingText && !noteTitle) {
              sameNoteAnchors.push({ nodeKey: child.getKey(), headingText });
            }
          }
          if ('getChildren' in child && typeof child.getChildren === 'function') {
            collectSameNoteAnchors(child as ReturnType<typeof $getRoot>);
          }
        }
      };
      collectSameNoteAnchors(root);
    });

    // Validate and update same-note anchors
    if (sameNoteAnchors.length > 0) {
      runIgnoredEditorUpdate(editor, () => {
        for (const { nodeKey, headingText } of sameNoteAnchors) {
          const node = $getNodeByKey(nodeKey);
          if ($isFileLinkNode(node)) {
            const isHeadingValid = editorHeadings.has(headingText.trim().toLowerCase());
            if (isHeadingValid) {
              $setLinkView(node, { resolutionState: 'fully_resolved' });
              $setLinkView(node, { noteId: null, isResolved: true });
            } else {
              $setLinkView(node, { resolutionState: 'heading_not_found' });
            }
          }
        }
      }, EDITOR_UPDATE_TAGS.ignored.skipDirty);
    }
  }, [editor]);

  // Handle backspace on FileLinkNodes - convert back to editable [[title#heading text
  useDecoratorBackspace({
    isTargetNode: $isFileLinkNode,
    getEditableText: (node) => {
      const title = node.getNoteTitle() || '';
      const heading = node.getHeadingText() ? `#${node.getHeadingText()}` : '';
      return `[[${title}${heading}`;
    }
  });

  const closeContextMenu = useCallback(() => {
    setContextMenuState(initialContextMenuState);
  }, []);

  return (
    <>
      <FileLinkPreview
        state={previewState}
        onMouseEnter={cancelHidePreview}
        onMouseLeave={hidePreview}
      />
      <FileLinkContextMenu
        state={contextMenuState}
        onOpenInNewWindow={handleOpenInNewWindow}
        onOpenSplitTab={openSplitTab}
        onClose={closeContextMenu}
      />
    </>
  );
}

/** @internal Exported for testing only. */
export const fileLinkPluginTestUtils = {
  FILE_LINK_PREVIEW_CARD_ATTRIBUTE,
  isFileLinkPreviewTarget,
  isFileLinkOrPreviewTarget,
  isPathLikeTarget,
  browserResolvePath,
  browserDirname,
  browserBasename,
  normalizeFilenameStem,
  resolvePathLikeExternalTarget,
  resolveNoteByTitleFromAtoms,
  resolveExternalSiblingByFilename,
  resolveFileLinkTargetNoteId,
  resolveExternalSiblingViaIpc,
  buildSameNoteHeadingPreviewState,
  buildSameNoteHeadingPreviewLoadState,
  buildPreviewCacheKey,
  buildPreviewTextFromMarkdown,
  extractHeadingSectionMarkdown
};

function $setLinkView(node: FileLinkNode, view: { noteId?: string | null; isResolved?: boolean; noteTitle?: string; resolutionState?: LinkResolutionState }): void {
  if ($isBoundEditor()) {
    setNodeView(node.getKey(), {
      ...(view.noteTitle !== undefined ? { noteTitle: view.noteTitle } : {}),
      ...(view.resolutionState !== undefined ? { resolutionState: view.resolutionState } : {}),
    });
    return;
  }
  if (view.isResolved !== undefined) node.setResolved(view.noteId ?? null, view.isResolved);
  if (view.noteTitle !== undefined) node.setNoteTitle(view.noteTitle);
  if (view.resolutionState !== undefined) node.setResolutionState(view.resolutionState);
}
