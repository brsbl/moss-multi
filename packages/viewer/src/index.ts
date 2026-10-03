// @moss-multi/viewer, tests-first harness: the entry contract with no moss renderer behind it yet. The
// acceptance fixture (e2e/viewer) runs against this bundle and must fail on its product assertions.
import type { MossViewerHandle, MossViewerOptions, MossViewerTheme } from './types.ts';

export type {
  MossViewerAssetKind,
  MossViewerHandle,
  MossViewerNote,
  MossViewerOptions,
  MossViewerServices,
  MossViewerTarget,
  MossViewerTheme,
  MossViewerUnfurl,
} from './types.ts';

/** The entry contract's version; viewer.json carries it too. */
export const MOSS_VIEWER_API = 1;

export function mountMossViewer(el: HTMLElement, options: MossViewerOptions): MossViewerHandle {
  const host = document.createElement('pre');
  host.dataset.mossViewer = '';
  host.dataset.theme = options.theme ?? 'light';
  host.dataset.mossViewerState = 'ready';
  host.textContent = options.markdown ?? '';
  el.append(host);
  return {
    title: '',
    frontmatter: null,
    ready: Promise.resolve(),
    setTheme(theme: MossViewerTheme) {
      host.dataset.theme = theme;
    },
    unmount() {
      host.remove();
    },
  };
}
