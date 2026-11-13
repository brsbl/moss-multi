// The viewer's identity, equal to viewer.json's `api`, `version` and `features` (vite.config.ts writes them from here
// and checks the version against package.json).
import type { MossViewerInfo } from './types.ts';

/** The entry contract's version; viewer.json carries it too. */
export const MOSS_VIEWER_API = 1;

export const MOSS_VIEWER_INFO: MossViewerInfo = Object.freeze({
  api: MOSS_VIEWER_API,
  version: '1.1.0',
  features: Object.freeze(['selection-1', 'share-with-agent-1']),
});
