// An HTML preview's frame survives its mode changes (T3.B27). The mode follows the note's measured width and the
// content's reported height (T3.B13), so it changes as a block first renders; a frame replaced on each change
// cancelled its load of the sandboxed frame document and started another, and WebKit then lost its network process.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { enableFrameDocument } from '@moss-multi/host/html-frame';
import { HtmlPreviewIframe, type HtmlPreviewIframeMode } from '@moss-desktop/renderer/editor/nodes/html/HtmlPreviewIframe';

describe('HTML preview frame', () => {
  it('keeps one frame, loading once, through fit, fit-scroll and scroll', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    enableFrameDocument();
    // jsdom's iframe has no sandbox token list; supportedSandbox probes one.
    if (!document.createElement('iframe').sandbox) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', { configurable: true, get: () => ({ supports: () => true }) });
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = (mode: HtmlPreviewIframeMode, viewportHeight: number) => act(async () => root.render(createElement(HtmlPreviewIframe, {
      srcDoc: '<p>seed</p>', title: 'HTML preview', viewportWidth: 800, viewportHeight, displayScale: 0.8, mode,
    })));
    try {
      await render('fit', 600);
      const frame = container.querySelector('iframe');
      expect(frame?.getAttribute('src')).toBe('/frame/html');
      for (const [mode, height] of [['fit-scroll', 900], ['scroll', 900], ['fit', 120]] as const) {
        await render(mode, height);
        expect(container.querySelectorAll('iframe'), mode).toHaveLength(1);
        expect(container.querySelector('iframe'), `${mode}: the same frame, not a new load`).toBe(frame);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      enableFrameDocument(null);
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
