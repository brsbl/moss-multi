// ported-from: packages/desktop/src/common/moss-html-runtime.ts @ 762abb777
/**
 * Shared HTML runtime utilities for previewing saved moss-html documents.
 * Rendering owns mechanics only; the saved HTML owns visual layout.
 */

import { parse, parseFragment, serialize } from 'parse5';

import { computeContentHash } from './content-hash';
import { getEmbedIframePolicy } from './embed-iframe-policy';
import { isSafeWebEmbedUrl } from './web-embed-url';
import {
  MOSS_HTML_NOTE_MEDIUM_HEIGHT,
  MOSS_HTML_NOTE_MEDIUM_WIDTH,
  resolveMossHtmlIntrinsicSize
} from './moss-html-dimensions';

/** Scrollbar suppression shared by live iframes and offscreen captures. */
export const MOSS_HIDE_SCROLLBARS_CSS = `html,body{scrollbar-width:none !important;-ms-overflow-style:none !important}
html::-webkit-scrollbar,body::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important}`;

/** Cursor affordances for common clickable controls inside sandboxed previews. */
export const MOSS_HTML_INTERACTIVE_CURSOR_CSS =
  `button:not(:disabled):not([onclick]):not([popovertarget]):not([form]):not([type="submit"]):not([type="reset"]),input[type="button"]:not(:disabled):not([onclick]),[role="button"]:not([onclick]):not([aria-disabled="true"]),[role="link"]:not([onclick]):not([aria-disabled="true"]),[role="menuitem"]:not([onclick]):not([aria-disabled="true"]){cursor:default !important}
a[href],summary,label[for],label:has(input:not(:disabled)),[onclick],button:not(:disabled)[onclick],button:not(:disabled)[popovertarget],button:not(:disabled)[form],button:not(:disabled)[type="submit"],button:not(:disabled)[type="reset"],input[type="submit"]:not(:disabled),input[type="reset"]:not(:disabled),input[type="checkbox"]:not(:disabled),input[type="radio"]:not(:disabled),input[type="range"]:not(:disabled),input[type="file"]:not(:disabled),input[type="color"]:not(:disabled),select:not(:disabled){cursor:pointer !important}
a[href="#"],a[href=""]{cursor:default !important}
input:not([type]),input[type="email"],input[type="number"],input[type="password"],input[type="search"],input[type="tel"],input[type="text"],input[type="url"],textarea,[contenteditable="true"]{cursor:text !important}`;

/** Runtime-only CSS injected into every preview iframe/capture. */
export const MOSS_HTML_RUNTIME_CSS = `${MOSS_HIDE_SCROLLBARS_CSS}
${MOSS_HTML_INTERACTIVE_CURSOR_CSS}`;

/**
 * Bump this when the preview runtime behavior changes in a way that should
 * invalidate cached HTML screenshots, even if the raw HTML is unchanged.
 */
export const MOSS_HTML_PREVIEW_CACHE_VERSION = 'v23';
export const MOSS_HTML_PREVIEW_RUNTIME_VERSION = MOSS_HTML_PREVIEW_CACHE_VERSION;

const FULL_DOCUMENT_RE = /<(?:html|head|body)\b/i;

// Fast gate so the parse5 round-trip only runs for HTML that actually contains a
// nested <iframe>. HTML without one is returned byte-identical, which keeps the
// existing preview output (and its PNG cache) unchanged.
const NESTED_IFRAME_PROBE_RE = /<iframe[\s/>]/i;

const POLICY_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  'sandbox',
  'referrerpolicy',
  'loading',
  'allow',
  'allowfullscreen'
]);

interface MossHtmlParse5Attr {
  name: string;
  value: string;
}

interface MossHtmlParse5Node {
  nodeName: string;
  tagName?: string;
  attrs?: MossHtmlParse5Attr[];
  childNodes?: MossHtmlParse5Node[];
  value?: string;
}

/**
 * Build the nested-iframe policy attributes from the shared `remote-webpage`
 * profile. Nested iframes in saved moss-html point at remote `src` URLs, so they
 * are policed as live remote webpage embeds (opaque origin: `allow-scripts
 * allow-forms`, no `allow-same-origin`), NOT with the `local-html-preview`
 * srcDoc sandbox. The `allow-same-origin` blank-render workaround only applies to
 * data:/srcDoc previews, never to a remote-`src` frame.
 */
const buildRemoteWebpageIframeAttrs = (): MossHtmlParse5Attr[] => {
  const policy = getEmbedIframePolicy('remote-webpage');
  const attrs: MossHtmlParse5Attr[] = [{ name: 'sandbox', value: policy.sandbox }];
  if (policy.referrerPolicy) {
    attrs.push({ name: 'referrerpolicy', value: policy.referrerPolicy });
  }
  if (policy.loading) {
    attrs.push({ name: 'loading', value: policy.loading });
  }
  if (policy.allow) {
    attrs.push({ name: 'allow', value: policy.allow });
  }
  if (policy.allowFullScreen) {
    attrs.push({ name: 'allowfullscreen', value: '' });
  }
  return attrs;
};

const normalizeIframeElement = (element: MossHtmlParse5Node): void => {
  const src = element.attrs?.find((attr) => attr.name === 'src')?.value ?? '';

  if (src && isSafeWebEmbedUrl(src)) {
    // Preserve non-policy attributes; drop inline event handlers and `srcdoc`
    // (srcdoc overrides src and would bypass the safe-HTTPS-source intent);
    // rewrite the sandbox/referrer/loading/allow attributes from the shared
    // `remote-webpage` policy (opaque origin, no `allow-same-origin`).
    const preserved = (element.attrs ?? []).filter((attr) => {
      const name = attr.name.toLowerCase();
      return (
        !POLICY_ATTRIBUTE_NAMES.has(name) &&
        name !== 'srcdoc' &&
        !name.startsWith('on')
      );
    });
    element.attrs = [...preserved, ...buildRemoteWebpageIframeAttrs()];
    return;
  }

  // Unsafe / empty / non-HTTPS / downloadable: replace with a blocked div.
  element.tagName = 'div';
  element.nodeName = 'div';
  element.attrs = [{ name: 'data-moss-blocked-iframe', value: 'true' }];
  element.childNodes = [{ nodeName: '#text', value: 'Iframe blocked' }];
};

/** Returns the number of real `<iframe>` elements that were normalized. */
const transformNestedIframes = (node: MossHtmlParse5Node): number => {
  const children = node.childNodes;
  if (!children) {
    return 0;
  }
  let transformed = 0;
  for (const child of children) {
    if (child.tagName === 'iframe') {
      normalizeIframeElement(child);
      transformed += 1;
      continue; // iframe content is replaced/irrelevant; do not descend.
    }
    transformed += transformNestedIframes(child);
  }
  return transformed;
};

/**
 * Normalize nested `<iframe>` tags in saved moss-html before it becomes preview
 * `srcDoc` or an offscreen capture. Safe HTTPS sources are kept and re-policed
 * with the shared `remote-webpage` iframe policy (opaque origin, no
 * `allow-same-origin`); unsafe sources become
 * `<div data-moss-blocked-iframe="true">Iframe blocked</div>`. Parser-backed
 * (parse5), never regex. HTML with no nested iframe is returned unchanged.
 */
export function normalizeMossHtmlNestedIframes(html: string): string {
  if (!NESTED_IFRAME_PROBE_RE.test(html)) {
    return html;
  }

  const isFullDocument = FULL_DOCUMENT_RE.test(html);
  const tree = isFullDocument ? parse(html) : parseFragment(html);
  // Walk/mutate via a minimal structural view; serialize the real parse5 tree
  // (mutations land on the same node objects).
  const transformed = transformNestedIframes(tree as unknown as MossHtmlParse5Node);
  if (transformed === 0) {
    // The `<iframe` substring matched but no real iframe element exists (e.g.
    // inside <textarea>/<title>/comment RCDATA). Keep the input byte-identical
    // so the HTML-preview PNG cache is not invalidated.
    return html;
  }
  return serialize(tree);
}

const buildRuntimeStyleTag = (trailingHeadCss?: string): string => {
  const cssBlocks = [MOSS_HTML_RUNTIME_CSS];
  if (trailingHeadCss) {
    cssBlocks.push(trailingHeadCss);
  }
  const css = cssBlocks.join('\n');
  return `<style data-moss-runtime="preview">${css}</style>`;
};

const buildDimensionReporterScriptTag = (reportId: string): string => {
  const encodedReportId = JSON.stringify(reportId);

  return `<script data-moss-runtime="dimensions">(() => {
  const REPORT_ID = ${encodedReportId};
  const MESSAGE_TYPE = 'moss-html-rendered-size';
  const REQUEST_TYPE = 'moss-html-measure-request';
  let frameHandle = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  const readRenderedSize = () => {
    const doc = document.documentElement;
    const body = document.body;
    if (!doc || !body) return null;

    const docRect = doc.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const originLeft = Math.min(0, docRect.left, bodyRect.left);
    const originTop = Math.min(0, docRect.top, bodyRect.top);
    let width = Math.max(
      doc.scrollWidth,
      body.scrollWidth,
      doc.offsetWidth,
      body.offsetWidth,
      doc.clientWidth,
      body.clientWidth,
      Math.ceil(docRect.right - originLeft),
      Math.ceil(bodyRect.right - originLeft)
    );
    let height = Math.max(
      doc.scrollHeight,
      body.scrollHeight,
      doc.offsetHeight,
      body.offsetHeight,
      doc.clientHeight,
      body.clientHeight,
      Math.ceil(docRect.bottom - originTop),
      Math.ceil(bodyRect.bottom - originTop)
    );

    const ignoredTags = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE']);
    for (const child of Array.from(body.querySelectorAll('*'))) {
      if (ignoredTags.has(child.tagName)) continue;
      const rect = child.getBoundingClientRect();
      if (!Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) continue;
      if (rect.width <= 0 && rect.height <= 0) continue;
      width = Math.max(width, Math.ceil(rect.right - originLeft));
      height = Math.max(height, Math.ceil(rect.bottom - originTop));
    }

    width = Math.round(width);
    height = Math.round(height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  };

  const report = () => {
    frameHandle = 0;
    const size = readRenderedSize();
    if (!size) return;
    if (size.width === lastWidth && size.height === lastHeight) return;
    lastWidth = size.width;
    lastHeight = size.height;
    window.parent?.postMessage({
      type: MESSAGE_TYPE,
      reportId: REPORT_ID,
      width: size.width,
      height: size.height
    }, '*');
  };

  const scheduleReport = () => {
    if (frameHandle) return;
    frameHandle = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(report);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleReport, { once: true });
  } else {
    scheduleReport();
  }
  window.addEventListener('load', scheduleReport, { once: true });
  if (document.fonts?.ready) {
    document.fonts.ready.then(scheduleReport, scheduleReport);
  }
  window.addEventListener('message', (event) => {
    if (event.data?.type === REQUEST_TYPE && event.data?.reportId === REPORT_ID) {
      scheduleReport();
    }
  });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scheduleReport);
    const observe = () => {
      if (document.documentElement) observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', observe, { once: true });
    } else {
      observe();
    }
  }
})()</script>`;
};

const injectRuntimeStyleIntoDocument = (
  html: string,
  styleTag: string,
  scriptTag: string
): string => {
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${styleTag}${scriptTag}</head>`);
  }
  if (/<body\b[^>]*>/i.test(html)) {
    return html.replace(/<body\b([^>]*)>/i, `<head>${styleTag}${scriptTag}</head><body$1>`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, `<html$1><head>${styleTag}${scriptTag}</head>`);
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${styleTag}${scriptTag}</head><body>${html}</body></html>`;
};

export interface MossHtmlRuntimeOptions {
  trailingHeadCss?: string;
  dimensionReportId?: string;
}

/**
 * Apply the Moss preview runtime to raw HTML.
 * - Fragments are wrapped only so they can be loaded as iframe srcDoc/data URLs.
 * - Full documents keep their structure and receive runtime-only CSS for
 *   scrollbar/capture mechanics, never visual body/page styling.
 */
export function wrapWithMossHtmlRuntime(
  html: string,
  options: MossHtmlRuntimeOptions = {}
): string {
  const styleTag = buildRuntimeStyleTag(options.trailingHeadCss);
  const scriptTag = options.dimensionReportId
    ? buildDimensionReporterScriptTag(options.dimensionReportId)
    : '';

  // Normalize nested iframes before wrapping (no-op for iframe-free HTML).
  const normalizedHtml = normalizeMossHtmlNestedIframes(html);

  if (FULL_DOCUMENT_RE.test(normalizedHtml)) {
    return injectRuntimeStyleIntoDocument(normalizedHtml, styleTag, scriptTag);
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${styleTag}${scriptTag}</head><body>${normalizedHtml}</body></html>`;
}

export interface MossHtmlPreviewHashOptions {
  cacheVersion?: string;
}

const buildMossHtmlPreviewHashSeed = (
  rawHtml: string,
  cacheVersion: string
): string => {
  const trimmed = rawHtml.trim();
  if (cacheVersion === 'v8') {
    return `${cacheVersion}:${trimmed}`;
  }

  const outputSize = cacheVersion === 'v11'
    ? {
        width: MOSS_HTML_NOTE_MEDIUM_WIDTH,
        height: MOSS_HTML_NOTE_MEDIUM_HEIGHT
      }
    : resolveMossHtmlIntrinsicSize(trimmed);

  return `${cacheVersion}:output=${outputSize.width}x${outputSize.height}:${trimmed}`;
};

export function computeMossHtmlPreviewHash(
  rawHtml: string,
  options: MossHtmlPreviewHashOptions = {}
): string {
  const cacheVersion = options.cacheVersion ?? MOSS_HTML_PREVIEW_CACHE_VERSION;
  return computeContentHash(buildMossHtmlPreviewHashSeed(rawHtml, cacheVersion));
}

export interface MossHtmlPreviewDescriptor {
  cacheVersion: string;
  contentHash: string;
  filename: string;
  relativePath: string;
}

export function describeMossHtmlPreview(
  rawHtml: string,
  options: MossHtmlPreviewHashOptions = {}
): MossHtmlPreviewDescriptor {
  const cacheVersion = options.cacheVersion ?? MOSS_HTML_PREVIEW_CACHE_VERSION;
  const contentHash = computeMossHtmlPreviewHash(rawHtml, { cacheVersion });
  const filename = `html-preview-${contentHash}.png`;

  return {
    cacheVersion,
    contentHash,
    filename,
    relativePath: `assets/.moss-cache/html-preview/${filename}`
  };
}

export type MossHtmlRetainedPreviewDescriptors = [
  current: MossHtmlPreviewDescriptor
];

/**
 * Preview assets Moss may read or keep for a live HTML block.
 */
export function describeMossHtmlRetainedPreviewDescriptors(
  rawHtml: string
): MossHtmlRetainedPreviewDescriptors {
  return [describeMossHtmlPreview(rawHtml)];
}
