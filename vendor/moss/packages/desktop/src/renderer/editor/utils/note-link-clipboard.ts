// ported-from: packages/desktop/src/renderer/editor/utils/note-link-clipboard.ts @ 762abb777
export const MOSS_NOTE_LINK_CLIPBOARD_MIME = 'application/x-moss-note-link';
const MOSS_NOTE_LINK_HTML_DATA_ATTR = 'data-moss-note-link';

/**
 * Bubbling DOM CustomEvent dispatched from the editor root when a note/anchor
 * link is copied from inside the editor (e.g. the collapsible-heading context
 * menu). The canvas listens for it on its scroll container so the toast stays
 * scoped to the originating editor pane.
 */
export const NOTE_LINK_COPIED_EVENT = 'moss:note-link-copied';
export const NOTE_LINK_COPIED_MESSAGE = 'Link copied';
export const ANCHOR_LINK_COPIED_MESSAGE = 'Anchor link copied';
export type NoteLinkCopiedEventDetail = { message: string };

export type MossNoteLinkClipboardPayload = {
  noteId: string;
  noteTitle: string;
  wikiLink: string;
};

export type NoteLinkClipboardData = {
  payload: MossNoteLinkClipboardPayload;
  plainText: string;
};

export type ParsedWikiLinkTarget = {
  noteTitle: string;
  headingText: string | null;
  noteId: string | null;
  displayText: string | null;
};

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const parseWikiLinkContent = (
  wikiLink: string
): string | null => {
  const trimmed = wikiLink.trim();
  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) {
    return null;
  }

  const content = trimmed.slice(2, -2).trim();
  return content.length > 0 ? content : null;
};

export const buildNoteLinkTarget = (
  noteTitle: string,
  folderPath?: string | null
): string => {
  const title = noteTitle.trim();
  if (!title) {
    return '';
  }

  const folder = (folderPath ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/^Notes(?:\/|$)/, '')
    .replace(/\/+/g, '/');

  return folder.length > 0 ? `${folder}/${title}` : title;
};

export const buildHeadingAnchorWikiLink = ({
  noteId,
  noteTitle,
  folderPath,
  headingText,
  sameNote = false
}: {
  noteId?: string | null;
  noteTitle?: string | null;
  folderPath?: string | null;
  headingText: string;
  sameNote?: boolean;
}): string | null => {
  const heading = headingText.trim();
  if (!heading) {
    return null;
  }

  if (sameNote) {
    return `[[#${heading}]]`;
  }

  const target = buildNoteLinkTarget(noteTitle ?? '', folderPath);
  const resolvedNoteId = noteId?.trim() ?? '';
  if (!target || !resolvedNoteId) {
    return null;
  }

  return `[[${target}#${heading}|${resolvedNoteId}]]`;
};

/**
 * Build the plain-text representation of a note link — a filesystem-style path.
 * This is what lands on the clipboard's `text/plain` flavor, so pasting a note
 * link into an external (non-Moss) app yields a readable path rather than raw
 * wiki-link syntax.
 */
const buildNotePathPlainText = (
  noteTitle: string,
  filesystemPath?: string | null
): string => {
  const title = noteTitle.trim() || 'Untitled';
  const resolvedFilesystemPath = filesystemPath?.trim() ?? '';
  return resolvedFilesystemPath.length > 0
    ? resolvedFilesystemPath.replace(/^\/Users\/[^/]+/, '~')
    : `~/Moss/Notes/${title}/${title}.md`;
};

export const buildCopyNoteLinkClipboardData = ({
  noteId,
  noteTitle,
  folderPath,
  filesystemPath,
  headingText
}: {
  noteId: string;
  noteTitle: string;
  folderPath?: string | null;
  filesystemPath?: string | null;
  headingText?: string | null;
}): NoteLinkClipboardData => {
  const title = noteTitle.trim() || 'Untitled';
  const heading = headingText?.trim() ?? '';
  // External paste always uses a plain path, matching non-anchor note links.
  const plainText = buildNotePathPlainText(title, filesystemPath);

  if (heading) {
    const headingWikiLink = buildHeadingAnchorWikiLink({
      noteId,
      noteTitle: title,
      folderPath,
      headingText: heading
    });
    if (headingWikiLink) {
      const noteTarget = buildNoteLinkTarget(title, folderPath);
      return {
        payload: {
          noteId,
          noteTitle: noteTarget || title,
          wikiLink: headingWikiLink
        },
        plainText
      };
    }
  }

  const wikiLink = `[[${title}|${noteId}]]`;
  return {
    payload: {
      noteId,
      noteTitle: title,
      wikiLink
    },
    plainText
  };
};

/**
 * Build clipboard data for a same-note heading anchor (`[[#Heading]]`).
 * The rich `text/html` payload preserves the wiki anchor for in-Moss paste,
 * while `text/plain` is a plain path for external paste — matching the behavior
 * of regular note links.
 */
export const buildSameNoteAnchorClipboardData = ({
  noteTitle,
  filesystemPath,
  headingText
}: {
  noteTitle: string;
  filesystemPath?: string | null;
  headingText: string;
}): NoteLinkClipboardData | null => {
  const wikiLink = buildHeadingAnchorWikiLink({ headingText, sameNote: true });
  if (!wikiLink) {
    return null;
  }

  return {
    payload: {
      noteId: '',
      noteTitle: '',
      wikiLink
    },
    plainText: buildNotePathPlainText(noteTitle, filesystemPath)
  };
};

export const parseWikiLinkTarget = (
  wikiLink: string,
  expectedNoteId?: string
): ParsedWikiLinkTarget | null => {
  const content = parseWikiLinkContent(wikiLink);
  if (!content) {
    return null;
  }

  const pipeIndex = content.lastIndexOf('|');
  const primary = pipeIndex >= 0 ? content.slice(0, pipeIndex).trim() : content;
  const suffix = pipeIndex >= 0 ? content.slice(pipeIndex + 1).trim() : '';
  if (!primary) {
    return null;
  }

  const hashIndex = primary.indexOf('#');
  const noteTitle = hashIndex >= 0 ? primary.slice(0, hashIndex).trim() : primary;
  const heading = hashIndex >= 0 ? primary.slice(hashIndex + 1).trim() : '';

  if (!noteTitle && !heading) {
    return null;
  }

  const normalizedExpectedNoteId = expectedNoteId?.trim() ?? '';
  const isExpectedResolvedNoteId =
    normalizedExpectedNoteId.length > 0 && suffix === normalizedExpectedNoteId;
  const isResolvedNoteId = isExpectedResolvedNoteId || UUID_PATTERN.test(suffix);

  return {
    noteTitle,
    headingText: heading.length > 0 ? heading : null,
    noteId: isResolvedNoteId ? suffix : null,
    displayText: suffix.length > 0 && !isResolvedNoteId ? suffix : null
  };
};

/**
 * Pick the copy-toast message for a copied note link. A link that targets a
 * specific heading (an anchor) reports the anchor-specific message; a plain
 * note link reports the generic one. Both the top-nav copy button and the
 * heading context menu route through this so the feedback stays consistent
 * with what actually landed on the clipboard.
 */
export const resolveNoteLinkCopiedMessage = (wikiLink: string): string =>
  parseWikiLinkTarget(wikiLink)?.headingText
    ? ANCHOR_LINK_COPIED_MESSAGE
    : NOTE_LINK_COPIED_MESSAGE;

export const serializeMossNoteLinkClipboardPayload = (
  payload: MossNoteLinkClipboardPayload
): string => JSON.stringify(payload);

export const parseMossNoteLinkClipboardPayload = (
  raw: string
): MossNoteLinkClipboardPayload | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<MossNoteLinkClipboardPayload> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const noteId = typeof parsed.noteId === 'string' ? parsed.noteId.trim() : '';
    const noteTitle = typeof parsed.noteTitle === 'string' ? parsed.noteTitle.trim() : '';
    const wikiLink = typeof parsed.wikiLink === 'string' ? parsed.wikiLink.trim() : '';
    if (!wikiLink) {
      return null;
    }

    const target = parseWikiLinkTarget(wikiLink, noteId || undefined);
    if (!target) {
      return null;
    }

    return {
      noteId: noteId || target.noteId || '',
      noteTitle: noteTitle || target.noteTitle,
      wikiLink
    };
  } catch {
    return null;
  }
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const buildMossNoteLinkClipboardHtml = (
  payload: MossNoteLinkClipboardPayload
): string => {
  const encodedPayload = encodeURIComponent(serializeMossNoteLinkClipboardPayload(payload));
  return `<span ${MOSS_NOTE_LINK_HTML_DATA_ATTR}="${encodedPayload}">${escapeHtml(payload.wikiLink)}</span>`;
};

export const parseMossNoteLinkPayloadFromHtml = (
  html: string
): MossNoteLinkClipboardPayload | null => {
  if (!html.trim()) {
    return null;
  }

  if (typeof DOMParser === 'undefined') {
    const match = html.match(new RegExp(`${MOSS_NOTE_LINK_HTML_DATA_ATTR}="([^"]+)"`));
    if (!match) {
      return null;
    }
    return parseMossNoteLinkClipboardPayload(decodeURIComponent(match[1]));
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const encodedPayload = doc.body
      .querySelector(`[${MOSS_NOTE_LINK_HTML_DATA_ATTR}]`)
      ?.getAttribute(MOSS_NOTE_LINK_HTML_DATA_ATTR);
    if (!encodedPayload) {
      return null;
    }
    return parseMossNoteLinkClipboardPayload(decodeURIComponent(encodedPayload));
  } catch {
    return null;
  }
};

export type ResolvedWikiLinkTarget = {
  noteTitle: string;
  headingText: string | null;
};

/**
 * Parses a resolved Moss wiki link like `[[Title#Heading|note-id]]`.
 * Returns the title/heading pair when the optional noteId matches.
 */
export const parseResolvedWikiLinkTarget = (
  wikiLink: string,
  expectedNoteId?: string
): ResolvedWikiLinkTarget | null => {
  const target = parseWikiLinkTarget(wikiLink, expectedNoteId);
  if (!target?.noteId) {
    return null;
  }
  if (expectedNoteId && target.noteId !== expectedNoteId.trim()) {
    return null;
  }
  if (!target.noteTitle) {
    return null;
  }

  return {
    noteTitle: target.noteTitle,
    headingText: target.headingText
  };
};
