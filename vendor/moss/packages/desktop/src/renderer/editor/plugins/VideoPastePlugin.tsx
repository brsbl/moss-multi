// ported-from: packages/desktop/src/renderer/editor/plugins/VideoPastePlugin.tsx @ 762abb777
/**
 * VideoPastePlugin
 *
 * Intercepts paste of YouTube URLs and local video files,
 * converting them to VideoNode elements.
 */
import { useEffect } from 'react';

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { objectKlassEquals } from '@lexical/utils';
import {
  $createRangeSelection,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_NORMAL,
  PASTE_COMMAND,
  type LexicalEditor
} from 'lexical';

import { $createImageNode } from '../nodes/ImageNode';
import { $createVideoNode } from '../nodes/VideoNode';
import { isYouTubeUrl } from '../utils/video-url';
import { useCurrentNoteId } from '../CurrentNoteIdContext';
import { imagesApi } from '../../api/electron';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';
import { MEDIA_UPLOAD_REFUSED, refuseInput } from '@moss-multi/host/refusal';

const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

type SavedSelection = {
  anchorKey: string;
  anchorOffset: number;
  anchorType: 'text' | 'element';
  focusKey: string;
  focusOffset: number;
  focusType: 'text' | 'element';
};

function captureSelection(): SavedSelection | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  return {
    anchorKey: selection.anchor.key,
    anchorOffset: selection.anchor.offset,
    anchorType: selection.anchor.type,
    focusKey: selection.focus.key,
    focusOffset: selection.focus.offset,
    focusType: selection.focus.type
  };
}

function restoreSelection(saved: SavedSelection): boolean {
  const anchorNode = $getNodeByKey(saved.anchorKey);
  const focusNode = $getNodeByKey(saved.focusKey);
  if (!anchorNode || !focusNode) return false;
  const selection = $createRangeSelection();
  selection.anchor.set(saved.anchorKey, saved.anchorOffset, saved.anchorType);
  selection.focus.set(saved.focusKey, saved.focusOffset, saved.focusType);
  $setSelection(selection);
  return true;
}

function collectClipboardFiles(clipboardData: DataTransfer): File[] {
  const files = Array.from(clipboardData.files ?? []);
  if (files.length > 0) {
    return files;
  }

  return Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function readFileAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.split(',')[1] ?? null);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function registerVideoPaste(editor: LexicalEditor, noteId: string | null): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      const isClipboardEvent =
        typeof ClipboardEvent !== 'undefined'
          ? objectKlassEquals(event, ClipboardEvent)
          : event && typeof event === 'object' && 'clipboardData' in event;

      if (!isClipboardEvent) return false;

      const clipboardData = (event as ClipboardEvent).clipboardData;
      if (!clipboardData) return false;

      // Check for YouTube URL in plain text
      const plainText = clipboardData.getData('text/plain')?.trim() ?? '';
      if (plainText && isYouTubeUrl(plainText)) {
        event.preventDefault();
        (event as ClipboardEvent).stopPropagation();

        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const videoNode = $createVideoNode(plainText);
          selection.insertNodes([videoNode]);
        });

        return true;
      }

      // Check for video files in clipboard
      const files = collectClipboardFiles(clipboardData);
      if (files.length > 0 && noteId) {
        // moss-multi seam: hide-registry (A§9): uploads land in M3; until then a pasted image or video is refused
        // visibly (a browser File has no Electron `path`, so the video branch would drop it silently)
        if (hidden('media-upload') && Array.from(files).some(f => VIDEO_MIME_TYPES.includes(f.type) || f.type.startsWith('image/'))) {
          event.preventDefault();
          (event as ClipboardEvent).stopPropagation();
          refuseInput(MEDIA_UPLOAD_REFUSED);
          return true;
        }
        const videoFile = Array.from(files).find(f => VIDEO_MIME_TYPES.includes(f.type));
        if (videoFile) {
          // Electron exposes .path on File objects
          const filePath = (videoFile as File & { path?: string }).path;
          if (!filePath) return false;

          event.preventDefault();
          (event as ClipboardEvent).stopPropagation();

          const insertionPoint = captureSelection();
          if (!insertionPoint) return true;

          void imagesApi.copyFromPath.invoke({ filePath, noteId }).then((result) => {
            if (!result?.relativePath) return;
            editor.update(() => {
              if (!restoreSelection(insertionPoint)) return;
              const selection = $getSelection();
              if (!$isRangeSelection(selection)) return;
              const videoNode = $createVideoNode(result.relativePath);
              selection.insertNodes([videoNode]);
            });
          }).catch((err) => {
            console.warn('[VideoPastePlugin] Failed to copy video file:', err);
          });

          return true;
        }

        // Check for image files in clipboard (e.g., screenshot paste)
        const imageFile = Array.from(files).find(f => f.type.startsWith('image/'));
        if (imageFile) {
          event.preventDefault();
          (event as ClipboardEvent).stopPropagation();

          const insertionPoint = captureSelection();
          if (!insertionPoint) return true;

          void readFileAsBase64(imageFile).then((base64Data) => {
            if (!base64Data) return;

            void imagesApi.save.invoke({
              data: base64Data,
              filename: imageFile.name || 'screenshot.png',
              mimeType: imageFile.type || 'image/png',
              noteId
            }).then((result) => {
              if (!result?.relativePath) return;
              editor.update(() => {
                if (!restoreSelection(insertionPoint)) return;
                const selection = $getSelection();
                if (!$isRangeSelection(selection)) return;
                const imageNode = $createImageNode(result.relativePath, imageFile.name || 'Screenshot');
                selection.insertNodes([imageNode]);
              });
            }).catch((err) => {
              console.warn('[VideoPastePlugin] Failed to save pasted image:', err);
            });
          }).catch((err) => {
            console.warn('[VideoPastePlugin] Failed to read pasted image:', err);
          });

          return true;
        }
      }

      return false;
    },
    COMMAND_PRIORITY_NORMAL
  );
}

export function VideoPastePlugin(): null {
  const [editor] = useLexicalComposerContext();
  const noteId = useCurrentNoteId();

  useEffect(() => {
    return registerVideoPaste(editor, noteId);
  }, [editor, noteId]);

  return null;
}
