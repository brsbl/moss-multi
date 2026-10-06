// @moss-multi/editor frame entry (moss-editor.js): moss's own editor, editable, on one note in a host's Moss
// workspace, reaching files only through the host's bridge (contract.ts, API 1). Load moss-editor.css in the same
// document. Prism goes on the global scope before moss's prism-setup and any code-highlighting module evaluates.
import '@moss-multi/host/prism-global.ts';
import '@moss-desktop/renderer/editor/plugins/code-block/prism-setup';
import './editor.css';

export { mountMossEditor } from './mount';
export { MOSS_EDITOR_API, MOSS_EDITOR_INFO } from './info';
export type * from './contract';
