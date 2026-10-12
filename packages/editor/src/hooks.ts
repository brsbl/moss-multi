// The editor's answers to moss-multi's host hooks (A§2.2): a note's HTML blocks load its editor's frame document
// (`htmlFrameUrl`, served with editor.json `htmlFrame.policy`), or moss's data: frames with scripts blocked without one.
// A block in the frame document runs only after the user presses its Run button, and stays allowed while its editor
// is mounted (PRODUCT ruling 21). The choice is kept by the block's node key: moss's static and interactive frames
// sit inside the block, and its fullscreen frame, portalled out of it, carries the key in its scope. A frame with no
// block key runs only on a Run pressed in that frame. Never by HTML, since two blocks can hold the same HTML.
import { gateFrameScripts, resolveFrameDocument, type FrameScope } from '@moss-multi/host/html-frame.ts';
import { editorFor, editorHolding } from './registry';

const blockOf = (iframe: HTMLIFrameElement, scope: FrameScope) =>
  iframe.closest('[data-block-decorator-key]')?.getAttribute('data-block-decorator-key') ?? scope.block ?? null;

const ranFrames = new WeakSet<HTMLIFrameElement>();

export function installEditorHooks(): void {
  resolveFrameDocument((noteId) => {
    const record = editorFor(noteId);
    return record ? record.htmlFrameUrl : undefined;
  });
  const owner = (iframe: HTMLIFrameElement, scope: FrameScope) => editorHolding(iframe) ?? editorFor(scope.noteId);
  gateFrameScripts({
    allowed: (iframe, scope) => {
      const block = blockOf(iframe, scope);
      if (block === null) return ranFrames.has(iframe);
      return owner(iframe, scope)?.ran.has(block) ?? false;
    },
    allow: (iframe, scope) => {
      const block = blockOf(iframe, scope);
      if (block === null) ranFrames.add(iframe);
      else owner(iframe, scope)?.ran.add(block);
    },
  });
}
