// ported-from: packages/desktop/src/renderer/editor/plugins/CommentPlugin.tsx @ 762abb777 (extracted)
import { type LexicalCommand, createCommand } from 'lexical';
import type { CreateCommentPayload } from './plugins/CommentPlugin';

/**
 * Command to create a comment on the current selection.
 * The plugin handles wrapping the selection with a MarkNode
 * and updating the comments atom.
 */
export const CREATE_COMMENT_COMMAND: LexicalCommand<CreateCommentPayload> =
  createCommand('CREATE_COMMENT_COMMAND');

export const OPEN_BLOCK_COMMENT_COMMAND: LexicalCommand<{ nodeKey: string }> =
  createCommand('OPEN_BLOCK_COMMENT_COMMAND');
