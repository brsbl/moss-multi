// T5.S10: the pane's paste handlers and the transforms that shape what a paste writes, as MarkdownEditor registers them
// (the same priorities and order), for the copy of the fork a Suggest-mode paste is measured on (paste.ts). Handlers
// with side effects beyond the note (asset uploads, video files) stay out: their nodes land later, as edits of their own.
import { registerCodeHighlighting } from '@lexical/code';
import { registerAutoLink } from '@lexical/link';
import { registerCheckList, registerList, registerListStrictIndentTransform } from '@lexical/list';
import { registerRichText } from '@lexical/rich-text';
import { registerTableCellUnmergeTransform, registerTablePlugin } from '@lexical/table';
import { mergeRegister } from '@lexical/utils';
import { registerAutoArrow } from '@moss-desktop/renderer/editor/AutoArrowPlugin';
import { AUTOLINK_MATCHERS, registerPasteFormattingHandlers } from '@moss-desktop/renderer/editor/MarkdownEditor';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { registerSafePaste } from '@moss-desktop/renderer/editor/plugins/SafePastePlugin';
import { registerWebpageEmbedPaste } from '@moss-desktop/renderer/editor/plugins/WebpageEmbedPastePlugin';
import { TextNode, type LexicalEditor } from 'lexical';

export function registerPasteStack(editor: LexicalEditor): () => void {
  return mergeRegister(
    registerRichText(editor),
    registerSafePaste(editor),
    registerList(editor),
    registerListStrictIndentTransform(editor),
    registerCheckList(editor),
    registerTablePlugin(editor),
    registerTableCellUnmergeTransform(editor),
    registerCodeHighlighting(editor),
    registerAutoArrow(editor),
    registerAutoLink(editor, { matchers: AUTOLINK_MATCHERS, changeHandlers: [], excludeParents: [] }),
    editor.registerNodeTransform(TextNode, $normalizeFormatWhitespace),
    registerWebpageEmbedPaste(editor),
    registerPasteFormattingHandlers(editor),
  );
}
