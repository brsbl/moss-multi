// HTML block previews: the viewer names a block's screenshot exactly as moss does at the pin, and reads it only
// through the owning viewer's assetUrl. The expected hashes were computed by moss's own module at 762abb777
// (packages/desktop/src/common/moss-html-runtime.ts) in Node, for every cacheVersion branch it has.
import { afterEach, describe, expect, it } from 'vitest';
import { computeMossHtmlPreviewHash, MOSS_HTML_PREVIEW_CACHE_VERSION } from '@moss-desktop/common/moss-html-runtime';
import { createViewerElectronApi } from './electron-api.ts';
import { ensureHtmlPreview, htmlPreviewCandidates } from './html-preview.ts';
import { registerViewer } from './registry.ts';

// rawHtml → [v8, v11, v23] content hashes from moss at the pin.
const PIN: [string, [string, string, string]][] = [
  ['<div style="width:640px;height:360px;display:grid;place-items:center;background:#f4efe1;font:600 32px system-ui">Seed swap poster</div>', ['94a0ae67e171c850', 'ac3b4bb1d1f114ec', 'f6f3e7c49f7eab85']],
  ['<div style="width:640px;height:240px;display:grid;place-items:center;background:#e1ecf4;font:600 28px system-ui">Drawer label draft</div>', ['f415098de742d3b6', '16c208ffa9eee30a', '7110f0621789a24b']],
  ['<div style="width:640px;height:300px;display:grid;place-items:center;background:#e4f1e0;font:600 28px system-ui">Planting chart</div>', ['45f589aac7c95e91', '274a43bcd253b305', 'cc4467ed46ca7e18']],
  ['<p>hi</p>', ['9a9543ff74c033d0', 'd7cb03adf906a44c', '777f78b43ace3f81']],
  ['\n  <!doctype html><html><head><style>body{margin:0}</style></head><body><h1>Seed swap</h1></body></html>\n', ['d554c16e2b4cff49', '7faa6220b6ac4e7d', '4b5700b56e5267bc']],
  ['<svg width="300" height="200" viewBox="0 0 300 200"><circle cx="150" cy="100" r="80"/></svg>', ['d7b2890a835b4b77', '07acdadc47570bbb', '77b9c693567ec4a8']],
  ['<div style="min-height:900px">Tall ☀️ ünïcode 🌱</div>', ['0aea14fcfa2fb071', 'b7af4caa4b160b7d', '57d2d5e5573a57de']],
];
const VERSIONS = ['v8', 'v11', 'v23'] as const;

describe('preview names', () => {
  it("are moss's hashes at the pin, for every cacheVersion branch", () => {
    expect(MOSS_HTML_PREVIEW_CACHE_VERSION).toBe('v23');
    for (const [rawHtml, hashes] of PIN) {
      expect(VERSIONS.map((cacheVersion) => computeMossHtmlPreviewHash(rawHtml, { cacheVersion }))).toEqual(hashes);
    }
  });

  it("are where moss's ensure reads them: the cache, then the legacy asset, at the view's cacheVersion", () => {
    for (const [rawHtml, [, , current]] of PIN) {
      expect(htmlPreviewCandidates(rawHtml)).toEqual([
        { relativePath: `assets/.moss-cache/html-preview/html-preview-${current}.png`, source: 'cache' },
        { relativePath: `assets/html-preview-${current}.png`, source: 'legacy-cache' },
      ]);
    }
  });
});

describe('ensureHtmlPreview', () => {
  const stops: (() => void)[] = [];
  afterEach(() => stops.splice(0).forEach((stop) => stop()));
  const [poster, [, , hash]] = PIN[0];
  const cache = `assets/.moss-cache/html-preview/html-preview-${hash}.png`;
  const legacy = `assets/html-preview-${hash}.png`;

  function viewer(noteId: string, resolves: (ref: string) => boolean = () => true) {
    const asked: string[] = [];
    stops.push(registerViewer(noteId, { notes: [], services: { assetUrl: (ref, kind) => (asked.push(`${kind}:${ref}`), resolves(ref) ? `/svc/${ref}` : null) } }));
    return asked;
  }

  it('answers the first screenshot that loads, from the URL assetUrl returned', async () => {
    const asked = viewer('moss-viewer-h1');
    const loaded: string[] = [];
    const loads = (present: string[]) => async (url: string) => (loaded.push(url), present.includes(url));

    expect(await ensureHtmlPreview('moss-viewer-h1', poster, loads([`/svc/${cache}`]))).toEqual({ relativePath: cache, source: 'cache' });
    expect(await ensureHtmlPreview('moss-viewer-h1', poster, loads([`/svc/${legacy}`]))).toEqual({ relativePath: legacy, source: 'legacy-cache' });
    expect(await ensureHtmlPreview('moss-viewer-h1', poster, loads([]))).toBeNull();
    expect(asked).toEqual([`image:${cache}`, `image:${cache}`, `image:${legacy}`, `image:${cache}`, `image:${legacy}`]);
    expect(loaded).toEqual([`/svc/${cache}`, `/svc/${cache}`, `/svc/${legacy}`, `/svc/${cache}`, `/svc/${legacy}`]);
  });

  it('loads nothing the services did not resolve, and nothing for another note or an empty block', async () => {
    viewer('moss-viewer-h2', (ref) => ref === legacy);
    const loaded: string[] = [];
    const loads = async (url: string) => (loaded.push(url), true);
    expect(await ensureHtmlPreview('moss-viewer-h2', poster, loads)).toEqual({ relativePath: legacy, source: 'legacy-cache' });
    expect(await ensureHtmlPreview('some-other-note', poster, loads)).toBeNull();
    expect(await ensureHtmlPreview('moss-viewer-h2', '   ', loads)).toBeNull();
    expect(loaded).toEqual([`/svc/${legacy}`]);
  });

  it("is the electronAPI's htmlPreview.ensure, which never generates a screenshot", async () => {
    const asked = viewer('moss-viewer-h3');
    const api = createViewerElectronApi() as Record<string, Record<string, (...args: unknown[]) => unknown>>;
    // Node has no Image, so nothing loads; the call still resolves through the owning viewer's assetUrl.
    expect(await api.htmlPreview.ensure({ noteId: 'moss-viewer-h3', rawHtml: poster, priority: 'visible', force: true })).toBeNull();
    expect(asked).toEqual([`image:${cache}`, `image:${legacy}`]);
    expect(typeof api.htmlPreview.onMaterialized(() => undefined)).toBe('function');
  });
});
