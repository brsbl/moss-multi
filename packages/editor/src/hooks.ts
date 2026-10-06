// The editor's answers to moss-multi's host hooks (A§2.2): a note's HTML blocks load its editor's frame document
// (`htmlFrameUrl`, served with `sandbox allow-scripts`), or moss's data: frames with scripts blocked without one.
import { resolveFrameDocument } from '@moss-multi/host/html-frame.ts';
import { editorFor } from './registry';

export function installEditorHooks(): void {
  resolveFrameDocument((noteId) => {
    const record = editorFor(noteId);
    return record ? record.htmlFrameUrl : undefined;
  });
}
