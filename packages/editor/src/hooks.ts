// The editor's answers to moss-multi's host hooks (A§2.2): a note's HTML blocks load its editor's frame document
// (`htmlFrameUrl`, served with editor.json `htmlFrame.policy`), or moss's data: frames with scripts blocked without one.
// A block in the frame document runs only after the user presses its Run button, and stays allowed while its editor
// is mounted (PRODUCT ruling 21). The choice is kept by the block's node key, which moss's static and interactive
// frames share, and by the frame's HTML for a frame outside the block (moss's fullscreen view), which belongs to the
// editor the user last pressed in.
import { gateFrameScripts, resolveFrameDocument } from '@moss-multi/host/html-frame.ts';
import { activeEditor, editorFor, editorHolding } from './registry';

const blockOf = (iframe: HTMLIFrameElement) => iframe.closest('[data-block-decorator-key]')?.getAttribute('data-block-decorator-key') ?? null;

export function installEditorHooks(): void {
  resolveFrameDocument((noteId) => {
    const record = editorFor(noteId);
    return record ? record.htmlFrameUrl : undefined;
  });
  const owner = (iframe: HTMLIFrameElement) => editorHolding(iframe) ?? activeEditor();
  gateFrameScripts({
    allowed: (iframe, html) => {
      const ran = owner(iframe)?.ran;
      const block = blockOf(iframe);
      return !!ran && ((block !== null && ran.has(`block:${block}`)) || ran.has(`html:${html}`));
    },
    allow: (iframe, html) => {
      const ran = owner(iframe)?.ran;
      const block = blockOf(iframe);
      if (block !== null) ran?.add(`block:${block}`);
      ran?.add(`html:${html}`);
    },
  });
}
