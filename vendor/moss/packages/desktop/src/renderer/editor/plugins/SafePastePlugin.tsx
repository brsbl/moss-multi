// ported-from: packages/desktop/src/renderer/editor/plugins/SafePastePlugin.tsx @ 762abb777
/**
 * SafePastePlugin
 *
 * Dropbox Paper (and some other rich-text sources) can put extremely large / complex HTML
 * onto the clipboard. In rare cases this can crash the editor during paste handling.
 *
 * This plugin detects likely-problematic clipboard HTML and forces a plain-text paste
 * path to keep the app stable.
 */
import { useEffect } from 'react';

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { objectKlassEquals } from '@lexical/utils';
import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, PASTE_COMMAND, PASTE_TAG, type LexicalEditor } from 'lexical';

const DROPBOX_PAPER_MARKERS = [
  'paper.dropbox.com',
  'dropbox paper',
  'paper-attachments.dropboxusercontent.com'
];

const DETAILS_MARKERS = ['<details', '<summary'];

// Absolute upper bound on clipboard HTML we are willing to hand to the rich paste pipeline.
// Large HTML blobs (often span-heavy) can be very expensive to parse/convert.
const MAX_HTML_CHARS_FOR_RICH_PASTE = 250_000;

// If HTML is disproportionately larger than the plain text, it's usually span/style heavy.
const MIN_HTML_CHARS_FOR_RATIO_CHECK = 50_000;
const MAX_HTML_TO_TEXT_RATIO = 8;

const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, '\n');

export function shouldForcePlainTextPaste(html: string, plainText: string): boolean {
  if (!html) {
    return false;
  }

  const lower = html.toLowerCase();

  // Check markers first (these don't depend on plainText)
  if (DROPBOX_PAPER_MARKERS.some((marker) => lower.includes(marker))) {
    return true;
  }

  if (DETAILS_MARKERS.some((marker) => lower.includes(marker))) {
    return true;
  }

  // Check absolute size threshold (no plainText dependency)
  // This MUST come before the plainText empty check!
  if (html.length > MAX_HTML_CHARS_FOR_RICH_PASTE) {
    return true;
  }

  // Now check ratio (which requires plainText)
  const normalizedPlain = plainText ? plainText.trim() : '';
  if (normalizedPlain.length === 0) {
    // If plain text is empty/whitespace but HTML is moderately large, force plain paste
    // This prevents bypassing protection with whitespace-only plain text
    if (html.length >= MIN_HTML_CHARS_FOR_RATIO_CHECK) {
      return true;
    }
    // No plainText and small HTML = can't compute ratio, allow rich paste
    return false;
  }

  if (html.length < MIN_HTML_CHARS_FOR_RATIO_CHECK) {
    return false;
  }

  return html.length / normalizedPlain.length > MAX_HTML_TO_TEXT_RATIO;
}

function getPlainTextFallback(html: string): string {
  // We avoid expensive/sophisticated HTML→text conversion here.
  // This fallback is only used if the clipboard doesn't provide text/plain.
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body?.textContent ?? '';
  } catch {
    return '';
  }
}

export function registerSafePaste(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      // Only handle ClipboardEvents - InputEvent/KeyboardEvent don't have clipboardData.
      // Use ClipboardEvent check if available (browser), otherwise use duck typing (jsdom tests).
      const isClipboardEvent = typeof ClipboardEvent !== 'undefined'
        ? objectKlassEquals(event, ClipboardEvent)
        : event && typeof event === 'object' && 'clipboardData' in event;

      if (!isClipboardEvent) {
        return false;
      }

      const clipboardData = (event as ClipboardEvent).clipboardData;
      if (!clipboardData) {
        return false;
      }

      const html = clipboardData.getData('text/html') ?? '';
      const plainText = clipboardData.getData('text/plain') ?? '';

      if (!shouldForcePlainTextPaste(html, plainText)) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();

      const textToInsert = normalizeLineEndings(plainText || getPlainTextFallback(html));
      if (!textToInsert) {
        return true;
      }

      let insertSucceeded = false;
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertRawText(textToInsert);
            insertSucceeded = true;
          }
        },
        { tag: PASTE_TAG }
      );

      // Only claim we handled the paste if we actually inserted text
      return insertSucceeded;
    },
    COMMAND_PRIORITY_HIGH
  );
}

export function SafePastePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return registerSafePaste(editor);
  }, [editor]);

  return null;
}
