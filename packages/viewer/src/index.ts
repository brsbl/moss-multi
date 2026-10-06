// @moss-multi/viewer: a moss note, read-only, in any page. It renders with moss's own editor, nodes and views at
// the pin (no second renderer), opens no socket and writes nothing; it reaches outside its bundle only through the
// services the host passes. Load moss-viewer.css (moss's tokens, Tailwind layers and fonts) in the same document.
// Prism goes on the global scope before moss's prism-setup and any code-highlighting module evaluates (L§4.1).
import '@moss-multi/host/prism-global.ts';
import '@moss-desktop/renderer/editor/plugins/code-block/prism-setup';
import './viewer.css';

export { mountMossViewer } from './mount.tsx';
export { MOSS_VIEWER_API, MOSS_VIEWER_INFO } from './info.ts';
export type {
  MossSelection,
  MossViewerAssetKind,
  MossViewerFeature,
  MossViewerHandle,
  MossViewerInfo,
  MossViewerNote,
  MossViewerOptions,
  MossViewerServices,
  MossViewerTarget,
  MossViewerTheme,
  MossViewerUnfurl,
} from './types.ts';
