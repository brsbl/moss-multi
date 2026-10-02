// ported-from: packages/desktop/src/renderer/editor/utils/comment-mentions.ts @ 762abb777
const COMMENT_MENTION_START = '\u2063';
const COMMENT_MENTION_END = '\u2064';
const COMMENT_MENTION_ID_SEPARATOR = '\u2062';

export const normalizeCommentMentionTitle = (value: string): string => {
  return value.replace(/^🔗\s*/u, '').trim();
};

export const encodeCommentMention = (
  title: string,
  type?: 'folder' | 'note',
  id?: string
): string => {
  const normalized = normalizeCommentMentionTitle(title);
  if (!normalized) {
    return '';
  }
  const prefix = type === 'folder' ? '@folder:' : '@';
  const encodedId = id && id !== normalized ? `${COMMENT_MENTION_ID_SEPARATOR}${id}` : '';
  return `${COMMENT_MENTION_START}${prefix}${normalized}${encodedId}${COMMENT_MENTION_END}`;
};

export const stripCommentMentionMarkers = (text: string): string => {
  return text
    .replace(/\u2063([^\u2064]*?)(?:\u2062[^\u2064]*)?\u2064/g, '$1')
    .split(COMMENT_MENTION_START).join('')
    .split(COMMENT_MENTION_END).join('');
};

export type CommentMentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; value: string; mentionType: 'folder' | 'note'; mentionId?: string };

export const splitCommentMentionSegments = (text: string): CommentMentionSegment[] => {
  if (!text.includes(COMMENT_MENTION_START)) {
    return [{ type: 'text', value: text }];
  }

  const segments: CommentMentionSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const mentionStart = text.indexOf(COMMENT_MENTION_START, cursor);
    if (mentionStart < 0) {
      const tail = text.slice(cursor);
      if (tail) {
        segments.push({ type: 'text', value: tail });
      }
      break;
    }

    if (mentionStart > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, mentionStart) });
    }

    const mentionEnd = text.indexOf(
      COMMENT_MENTION_END,
      mentionStart + COMMENT_MENTION_START.length
    );
    if (mentionEnd < 0) {
      segments.push({ type: 'text', value: text.slice(mentionStart) });
      break;
    }

    const rawMentionContent = text
      .slice(mentionStart + COMMENT_MENTION_START.length, mentionEnd)
      .trim();
    const idSeparatorIndex = rawMentionContent.indexOf(COMMENT_MENTION_ID_SEPARATOR);
    const mentionContent =
      idSeparatorIndex >= 0 ? rawMentionContent.slice(0, idSeparatorIndex) : rawMentionContent;
    const mentionId =
      idSeparatorIndex >= 0
        ? rawMentionContent.slice(idSeparatorIndex + COMMENT_MENTION_ID_SEPARATOR.length)
        : undefined;
    if (mentionContent.length > 0) {
      const isFolder = mentionContent.startsWith('@folder:');
      const value = isFolder ? mentionContent.replace('@folder:', '@') : mentionContent;
      segments.push({
        type: 'mention',
        value,
        mentionType: isFolder ? 'folder' : 'note',
        ...(mentionId ? { mentionId } : {})
      });
    }

    cursor = mentionEnd + COMMENT_MENTION_END.length;
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: '' }];
};

// ---------------------------------------------------------------------------
// Lexical editor serialize/deserialize for MentionInput
// ---------------------------------------------------------------------------

import {
  $generateNodesFromMarkdownString,
  $convertToMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  type TextMatchTransformer,
  type Transformer
} from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type LexicalEditor
} from 'lexical';
import { MentionNode, $isMentionNode, $createMentionNode } from '../../prompt/MentionNode';

/**
 * Serialize a Lexical editor containing TextNodes and MentionNodes into the
 * encoded comment string format (invisible Unicode markers around mentions).
 */
export interface SerializeCommentEditorOptions {
  /** Preserve real mention ids for prompt drafts that can be remounted. */
  preserveMentionIds?: boolean;
  /** Preserve basic inline Markdown formatting in action-composer drafts. */
  simpleMarkdown?: boolean;
  /** Render mentions as visible @labels instead of encoded draft metadata. */
  mentionsAsText?: boolean;
}

export const SIMPLE_ACTION_MARKDOWN_TRANSFORMERS: Transformer[] = [
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH
];

function createMentionMarkdownTransformer(
  options?: SerializeCommentEditorOptions
): TextMatchTransformer {
  return {
    dependencies: [MentionNode],
    export: (node) => {
      if (!$isMentionNode(node)) return null;
      const title = node.getMentionTitle();
      if (options?.mentionsAsText) {
        return `@${title}`;
      }
      const rawType = node.getMentionType();
      const mentionType: 'folder' | 'note' =
        rawType === 'directory' || rawType === 'folder' ? 'folder' : 'note';
      return encodeCommentMention(
        title,
        mentionType,
        options?.preserveMentionIds ? node.getMentionId() : undefined
      );
    },
    // Mention insertion is owned by MentionPlugin. This transformer only gives
    // Markdown export a stable representation for decorator nodes.
    regExp: /$^/,
    type: 'text-match'
  };
}

export function serializeCommentEditor(
  editor: LexicalEditor,
  options?: SerializeCommentEditorOptions
): string {
  let result = '';
  editor.getEditorState().read(() => {
    if (options?.simpleMarkdown) {
      result = $convertToMarkdownString(
        [...SIMPLE_ACTION_MARKDOWN_TRANSFORMERS, createMentionMarkdownTransformer(options)],
        undefined,
        true
      );
      return;
    }

    const root = $getRoot();
    let elementIndex = 0;
    for (const child of root.getChildren()) {
      if (!$isElementNode(child)) continue;
      if (elementIndex > 0) {
        result += '\n';
      }
      elementIndex += 1;
      for (const node of child.getChildren()) {
        if ($isMentionNode(node)) {
          const title = node.getMentionTitle();
          const rawType = node.getMentionType();
          // Map directory → folder for comment encoding
          const mentionType: 'folder' | 'note' =
            rawType === 'directory' || rawType === 'folder' ? 'folder' : 'note';
          result += encodeCommentMention(
            title,
            mentionType,
            options?.preserveMentionIds ? node.getMentionId() : undefined
          );
        } else if ($isTextNode(node)) {
          result += node.getTextContent();
        } else if ($isLineBreakNode(node)) {
          result += '\n';
        }
      }
    }
  });
  return result;
}

/**
 * Deserialize an encoded comment string into a Lexical editor tree,
 * reconstructing MentionNodes from Unicode markers.
 */
export interface DeserializeCommentEditorOptions {
  /**
   * Resolve a note mention title to its real note id. Comment composers are
   * display-only and omit this (id = title); the docked prompt composer needs
   * real ids so submitted mentions target the right notes.
   */
  resolveNoteId?: (title: string) => string | null;
  /** Restore basic inline Markdown formatting in action-composer drafts. */
  simpleMarkdown?: boolean;
}

function appendSimpleMarkdownText(paragraph: ReturnType<typeof $createParagraphNode>, text: string) {
  const blocks = $generateNodesFromMarkdownString(
    text,
    SIMPLE_ACTION_MARKDOWN_TRANSFORMERS,
    true
  );
  for (const block of blocks) {
    if ($isElementNode(block)) {
      paragraph.append(...block.getChildren());
    } else {
      paragraph.append(block);
    }
  }
}

/** Populate the active Lexical editor update with encoded comment content. */
export function $deserializeCommentEditor(
  encodedText: string,
  options?: DeserializeCommentEditorOptions
): void {
  const lines = encodedText.split('\n');
  const root = $getRoot();
  root.clear();

  let lastParagraph = $createParagraphNode();

  for (const line of lines) {
    const paragraph = $createParagraphNode();
    const segments = splitCommentMentionSegments(line);

    for (const segment of segments) {
      if (segment.type === 'mention') {
        // segment.value starts with '@' — strip it for the title
        const title = segment.value.startsWith('@') ? segment.value.slice(1) : segment.value;
        if (title) {
          const mentionId =
            segment.mentionId ??
            (segment.mentionType === 'note' ? (options?.resolveNoteId?.(title) ?? title) : title);
          const mentionNode = $createMentionNode(
            mentionId,
            title,
            segment.mentionType // 'folder' | 'note'
          );
          paragraph.append(mentionNode);
        }
      } else {
        const text = stripCommentMentionMarkers(segment.value);
        if (text) {
          if (options?.simpleMarkdown) {
            appendSimpleMarkdownText(paragraph, text);
          } else {
            paragraph.append($createTextNode(text));
          }
        }
      }
    }

    root.append(paragraph);
    lastParagraph = paragraph;
  }

  lastParagraph.selectEnd();
}

export function deserializeCommentEditor(
  editor: LexicalEditor,
  encodedText: string,
  options?: DeserializeCommentEditorOptions
): void {
  editor.update(
    () => {
      $deserializeCommentEditor(encodedText, options);
    },
    { discrete: true }
  );
}
