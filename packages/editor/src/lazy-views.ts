// The node families whose views load on first use (T3.12): charts (with recharts), the canvas, and HTML blocks (with
// parse5). Each lives in its own chunk, fetched and evaluated only once a note holds one; a note that does is loaded
// with its chunks already in (preloadNodeViews), so it opens with no placeholder, and a block pasted or inserted
// later shows a placeholder of the view's size until its chunk arrives. Saving never depends on a view: the node
// classes and their markdown stay in the entry, so the bytes a save writes are unchanged.
import { createElement } from 'react';
import { loadNodeView, registerLazyNodeView } from '@moss-desktop/renderer/editor/nodes/node-views';

/** Heights of each view's first paint in the frame, from the e2e lazy-family leg (load.spec.ts). */
const PLACEHOLDER_HEIGHT = { chart: 330, sketch: 360, 'html-block': 160 } as const;

const placeholder = (type: keyof typeof PLACEHOLDER_HEIGHT) => () =>
  createElement('div', {
    contentEditable: false,
    'data-moss-lazy-view': type,
    'aria-busy': true,
    className: 'w-full rounded-lg bg-surface-panel/70',
    style: { height: PLACEHOLDER_HEIGHT[type] },
  });

// The chart view lazy-loads recharts itself (moss's ChartRenderer); both arrive together.
registerLazyNodeView(
  'chart',
  () => Promise.all([import('@moss-desktop/renderer/editor/nodes/ChartNode.view'), import('@moss-desktop/renderer/editor/components/ChartRenderer')]),
  placeholder('chart'),
);
registerLazyNodeView('sketch', () => import('@moss-desktop/renderer/editor/nodes/SketchNode.view'), placeholder('sketch'));
registerLazyNodeView('html-block', () => import('@moss-desktop/renderer/editor/nodes/HtmlBlockquoteNode.view'), placeholder('html-block'));

/**
 * Which lazy families `body` may hold, by the markdown that imports them: a ```moss-chart fence, a ```moss-canvas
 * (or legacy ```moss-sketch) fence, and a ```moss-html fence or an HTML blockquote. A superset is harmless; it only
 * loads a chunk early.
 */
const FAMILIES: [type: string, pattern: RegExp][] = [
  ['chart', /`{3,}\s*moss-chart/],
  ['sketch', /`{3,}\s*moss-(?:canvas|sketch)/],
  ['html-block', /`{3,}\s*moss-html|<blockquote|&lt;blockquote/i],
];

/** Loads the views `body` needs before it is shown; null when it needs none. A failed load leaves the placeholder. */
export function preloadNodeViews(body: string): Promise<void> | null {
  const loads = FAMILIES.filter(([, pattern]) => pattern.test(body)).map(([type]) => loadNodeView(type).catch(() => undefined));
  return loads.length > 0 ? Promise.all(loads).then(() => undefined) : null;
}
