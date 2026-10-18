// The DOM contract as e2e reads it: one module (A§19), so a rename breaks typecheck instead of a run.
import * as dom from '../../packages/protocol/src/dom-contract.ts';

export * from '../../packages/protocol/src/dom-contract.ts';

/** The attribute names browser-side detectors need; passed into page.evaluate. */
export const NAMES = {
  buildMeta: dom.BUILD_META,
  clientBuild: dom.CLIENT_BUILD_ATTR,
  pane: dom.EDITOR_PANE_ATTR,
  docId: dom.DOC_ID_ATTR,
  titleBinding: dom.TITLE_BINDING_ATTR,
  bodyBinding: dom.BODY_BINDING_ATTR,
  generation: dom.EDITOR_GENERATION_ATTR,
  canvas: dom.EDITOR_CANVAS_ATTR,
  collabChrome: dom.COLLAB_CHROME_ATTR,
  overlay: dom.OVERLAY_SURFACE_ATTR,
  toolbar: dom.FLOATING_TOOLBAR_ATTR,
  commentEntry: dom.COMMENT_ENTRY_ATTR,
  retentionNotice: dom.RETENTION_NOTICE_ATTR,
  remote: [dom.REMOTE_CARET_ATTR, dom.REMOTE_SELECTION_ATTR, dom.REMOTE_LABEL_ATTR],
  sidebarRow: dom.SIDEBAR_ROW_ATTR,
  lexical: dom.LEXICAL_EDITOR_SELECTOR,
  observe: 'data-e2e-observe',
} as const;

export type Names = typeof NAMES;

export const paneSelector = (docId: string) => `[${dom.EDITOR_PANE_ATTR}][${dom.DOC_ID_ATTR}="${docId}"]`;
