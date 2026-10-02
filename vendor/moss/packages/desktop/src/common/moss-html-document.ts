// ported-from: packages/desktop/src/common/moss-html-document.ts @ 762abb777
/**
 * Saved moss-html document helpers.
 * The persisted HTML owns its visual layout. Moss only owns a minimal
 * document shell and preview mechanics.
 */

import {
  describeMossHtmlPreview,
  type MossHtmlPreviewDescriptor
} from './moss-html-runtime';
import {
  DEFAULT_MOSS_HTML_HEIGHT,
  DEFAULT_MOSS_HTML_WIDTH,
  resolveMossHtmlIntrinsicSize
} from './moss-html-dimensions';

export const MOSS_HTML_DOCUMENT_VERSION = 'v1';
export const DEFAULT_MOSS_HTML_DOCUMENT_WIDTH = DEFAULT_MOSS_HTML_WIDTH;
export const DEFAULT_MOSS_HTML_DOCUMENT_HEIGHT = DEFAULT_MOSS_HTML_HEIGHT;

const DEFAULT_DOCUMENT_TITLE = 'HTML block';
const LEGACY_GENERATED_ARTIFACT_TITLE = 'Upgraded HTML artifact';
const DEFAULT_DOCUMENT_HEAD_HTML = `<style>
  * { box-sizing: border-box; }

  :root {
    --moss-page: floralwhite;
    --moss-panel: white;
    --moss-panel-warm: snow;
    --moss-ink: darkslategray;
    --moss-muted: dimgray;
    --moss-border: gainsboro;
    --moss-accent: seagreen;
    --moss-accent-soft: honeydew;
    --moss-warm-chip: papayawhip;
    --moss-warm-text: saddlebrown;
    --moss-shadow: lightgray;
  }

  html {
    background: var(--moss-page);
  }

  body {
    width: 1200px;
    min-height: 900px;
    margin: 0;
    padding: 48px;
    background: var(--moss-page);
    color: var(--moss-ink);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .demo-shell {
    min-height: 804px;
    display: grid;
    grid-template-columns: 1.08fr 0.92fr;
    gap: 28px;
    padding: 34px;
    border: 1px solid var(--moss-border);
    border-radius: 28px;
    background: var(--moss-panel-warm);
    box-shadow: 0 24px 70px var(--moss-shadow);
  }

  .hero-panel,
  .side-panel {
    border: 1px solid var(--moss-border);
    border-radius: 22px;
    background: var(--moss-panel);
    box-shadow: 0 10px 34px var(--moss-shadow);
  }

  .hero-panel {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 38px;
  }

  .side-panel {
    display: grid;
    gap: 18px;
    padding: 24px;
  }

  .eyebrow {
    width: max-content;
    padding: 8px 12px;
    border-radius: 999px;
    background: var(--moss-accent-soft);
    color: var(--moss-accent);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    margin-top: 24px;
    max-width: 650px;
    font-size: 58px;
    line-height: 1.02;
    letter-spacing: 0;
    color: var(--moss-ink);
  }

  .summary {
    margin-top: 18px;
    max-width: 610px;
    font-size: 19px;
    line-height: 1.55;
    color: var(--moss-muted);
  }

  .metric-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin-top: 44px;
  }

  .metric {
    padding: 18px;
    border: 1px solid var(--moss-border);
    border-radius: 18px;
    background: var(--moss-page);
  }

  .metric strong {
    display: block;
    font-size: 30px;
    line-height: 1;
    color: var(--moss-accent);
  }

  .metric span {
    display: block;
    margin-top: 8px;
    font-size: 13px;
    color: var(--moss-muted);
  }

  .timeline {
    display: grid;
    gap: 14px;
    margin-top: 38px;
  }

  .milestone {
    display: grid;
    grid-template-columns: 96px 1fr auto;
    align-items: center;
    gap: 18px;
    padding: 16px 18px;
    border: 1px solid var(--moss-border);
    border-radius: 18px;
    background: var(--moss-panel-warm);
  }

  .milestone time {
    font-size: 13px;
    font-weight: 700;
    color: var(--moss-accent);
  }

  .milestone b {
    display: block;
    font-size: 16px;
    color: var(--moss-ink);
  }

  .milestone small,
  .card small {
    display: block;
    margin-top: 5px;
    font-size: 13px;
    color: var(--moss-muted);
  }

  .status {
    padding: 6px 10px;
    border-radius: 999px;
    background: var(--moss-warm-chip);
    color: var(--moss-warm-text);
    font-size: 12px;
    font-weight: 700;
  }

  .side-panel h2 {
    font-size: 22px;
    color: var(--moss-ink);
  }

  .card {
    padding: 18px;
    border: 1px solid var(--moss-border);
    border-radius: 18px;
    background: var(--moss-page);
  }

  .card b {
    display: block;
    font-size: 16px;
  }

  .progress-track {
    height: 10px;
    margin-top: 16px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--moss-border);
  }

  .progress-bar {
    width: 72%;
    height: 100%;
    border-radius: inherit;
    background: var(--moss-accent);
  }

  .note-stack {
    display: grid;
    gap: 10px;
  }

  .note-row {
    display: grid;
    grid-template-columns: 10px 1fr;
    gap: 10px;
    align-items: start;
    color: var(--moss-muted);
    font-size: 14px;
    line-height: 1.45;
  }

  .dot {
    width: 10px;
    height: 10px;
    margin-top: 5px;
    border-radius: 50%;
    background: var(--moss-accent);
  }
</style>`;
const DEFAULT_DOCUMENT_BODY = [
  '<main class="demo-shell" aria-label="Moss HTML demo screen">',
  '  <section class="hero-panel">',
  '    <div>',
  '      <div class="eyebrow">Prototype canvas</div>',
  '      <h1>Launch room for the spring release</h1>',
  '      <p class="summary">A static-first planning surface with live status, decision checkpoints, and owner-ready follow-through.</p>',
  '      <div class="metric-row">',
  '        <div class="metric"><strong>72%</strong><span>scope settled</span></div>',
  '        <div class="metric"><strong>18</strong><span>launch notes linked</span></div>',
  '        <div class="metric"><strong>4</strong><span>open decisions</span></div>',
  '      </div>',
  '    </div>',
  '    <div class="timeline">',
  '      <article class="milestone">',
  '        <time>Today</time>',
  '        <div><b>Finalize onboarding copy</b><small>Brand, product, and support are aligned.</small></div>',
  '        <span class="status">Review</span>',
  '      </article>',
  '      <article class="milestone">',
  '        <time>Jun 12</time>',
  '        <div><b>Publish release room</b><small>QA notes and rollout checklist stay visible.</small></div>',
  '        <span class="status">Queued</span>',
  '      </article>',
  '    </div>',
  '  </section>',
  '  <aside class="side-panel">',
  '    <div>',
  '      <div class="eyebrow">Signal</div>',
  '      <h2>Readiness snapshot</h2>',
  '    </div>',
  '    <section class="card">',
  '      <b>Customer preview path</b>',
  '      <small>Draft build, release notes, and help center updates are grouped for review.</small>',
  '      <div class="progress-track"><div class="progress-bar"></div></div>',
  '    </section>',
  '    <section class="card note-stack">',
  '      <b>Decision queue</b>',
  '      <div class="note-row"><span class="dot"></span><span>Confirm beta cohort messaging before the ship room opens.</span></div>',
  '      <div class="note-row"><span class="dot"></span><span>Choose final screenshot set after foreground QA.</span></div>',
  '      <div class="note-row"><span class="dot"></span><span>Attach owner notes to the launch retrospective.</span></div>',
  '    </section>',
  '    <section class="card">',
  '      <b>Next checkpoint</b>',
  '      <small>Thursday status readout, 2:30 PM, product review channel.</small>',
  '    </section>',
  '  </aside>',
  '</main>'
].join('\n');

const HTML_TAG_RE = /<html\b([^>]*)>/i;
const BODY_TAG_RE = /<body\b([^>]*)>/i;
const HEAD_RE = /<head\b[^>]*>([\s\S]*?)<\/head>/i;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

const DOCUMENT_VERSION_META_RE =
  /\bname=["']moss-html-version["'][^>]*content=["']v\d+["'][^>]*>/i;
const MANAGED_STYLE_TAG_RE =
  /<style\b[^>]*data-moss-html-managed=["'][^"']*["'][^>]*>[\s\S]*?<\/style>\s*/gi;
const LEGACY_TEMPLATE_STYLE_TAG_RE =
  /<style\b[^>]*>[\s\S]*?(?:--artifact-bg|--artifact-card|\.moss-html-artifact|data-moss-html-artifact)[\s\S]*?<\/style>\s*/gi;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const extractTagAttributes = (rawHtml: string, tag: 'html' | 'body'): string => {
  const match = (tag === 'html' ? rawHtml.match(HTML_TAG_RE) : rawHtml.match(BODY_TAG_RE))?.[1];
  return match?.trim() ?? '';
};

const extractElementInnerHtml = (rawHtml: string, tagName: string): string | null => {
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'i');
  const openMatch = openRe.exec(rawHtml);
  if (!openMatch) {
    return null;
  }

  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  closeRe.lastIndex = openMatch.index + openMatch[0].length;

  let closeMatch: RegExpExecArray | null = null;
  let nextCloseMatch: RegExpExecArray | null;
  while ((nextCloseMatch = closeRe.exec(rawHtml)) !== null) {
    closeMatch = nextCloseMatch;
  }

  if (!closeMatch) {
    return null;
  }

  return rawHtml.slice(openMatch.index + openMatch[0].length, closeMatch.index);
};

const normalizeHtmlAttributes = (attrs: string): string => {
  const sanitized = attrs
    .replace(/(?:^|\s+)lang=(["'])[\s\S]*?\1/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  return sanitized ? ` lang="en" ${sanitized}` : ' lang="en"';
};

const normalizeBodyAttributes = (attrs: string): string => {
  const sanitized = attrs
    .replace(/(?:^|\s+)data-moss-html-artifact=(["'])[\s\S]*?\1/gi, ' ')
    .replace(/(?:^|\s+)data-moss-html-version=(["'])[\s\S]*?\1/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  return sanitized ? ` ${sanitized}` : '';
};

const stripManagedHeadHtml = (headHtml: string): string =>
  headHtml
    .replace(/<meta\b[^>]*charset=["'][^"']*["'][^>]*>\s*/gi, '')
    .replace(/<meta\b[^>]*charset=[^\s>]+[^>]*>\s*/gi, '')
    .replace(/<meta\b[^>]*name=["']viewport["'][^>]*>\s*/gi, '')
    .replace(/<meta\b[^>]*name=["']moss-html-version["'][^>]*>\s*/gi, '')
    .replace(/<meta\b[^>]*name=["']moss-html-artifact["'][^>]*>\s*/gi, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/gi, '')
    .replace(MANAGED_STYLE_TAG_RE, '')
    .replace(LEGACY_TEMPLATE_STYLE_TAG_RE, '')
    .trim();

const extractStyleTags = (rawHtml: string): string[] =>
  Array.from(rawHtml.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi))
    .map((match) => match[0])
    .filter(
      (styleTag) =>
        !/data-moss-html-managed=/i.test(styleTag) &&
        !/--artifact-bg|--artifact-card|\.moss-html-artifact|data-moss-html-artifact/i.test(styleTag)
    );

const extractTitle = (rawHtml: string): string | null => {
  const title = rawHtml.match(TITLE_RE)?.[1]?.trim();
  return title || null;
};

const extractPreservedHeadHtml = (rawHtml: string): string => {
  const preservedHead = stripManagedHeadHtml(rawHtml.match(HEAD_RE)?.[1] ?? '');
  if (preservedHead) {
    return preservedHead;
  }

  return extractStyleTags(rawHtml).join('\n').trim();
};

const stripFragmentHeadTags = (rawHtml: string): string =>
  rawHtml
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>\s*/gi, '')
    .trim();

const unwrapLegacyArtifactShell = (bodyInnerHtml: string): string => {
  const trimmed = bodyInnerHtml.trim();
  const legacyShellMatch = trimmed.match(
    /^<main\b[^>]*class=(["'])[^"']*\bmoss-html-artifact\b[^"']*\1[^>]*>([\s\S]*?)<\/main>$/i
  );

  return (legacyShellMatch?.[2] ?? trimmed).trim();
};

const stripLegacyGeneratedArtifactHeading = (bodyInnerHtml: string): string => {
  const headingRe = new RegExp(
    `^\\s*<h1\\b[^>]*>\\s*${LEGACY_GENERATED_ARTIFACT_TITLE.replace(/\s+/g, '\\s+')}\\s*</h1>\\s*`,
    'i'
  );

  return bodyInnerHtml.replace(headingRe, '').trim();
};

const extractBodyInnerHtml = (rawHtml: string): string => {
  const bodyInner = extractElementInnerHtml(rawHtml, 'body');
  if (typeof bodyInner === 'string') {
    return stripLegacyGeneratedArtifactHeading(unwrapLegacyArtifactShell(bodyInner));
  }

  return stripLegacyGeneratedArtifactHeading(stripFragmentHeadTags(rawHtml));
};

export interface MossHtmlDocumentOptions {
  title?: string;
  innerHtml?: string;
  extraHeadHtml?: string;
  htmlAttributes?: string;
  bodyAttributes?: string;
}

export function buildMossHtmlDocument(
  options: MossHtmlDocumentOptions = {}
): string {
  const title = options.title?.trim() || DEFAULT_DOCUMENT_TITLE;
  const innerHtml =
    options.innerHtml !== undefined
      ? options.innerHtml.trim()
      : DEFAULT_DOCUMENT_BODY;
  const extraHeadHtml = options.extraHeadHtml?.trim();
  const htmlAttributes = normalizeHtmlAttributes(options.htmlAttributes ?? '');
  const bodyAttributes = normalizeBodyAttributes(options.bodyAttributes ?? '');

  return `<!DOCTYPE html>
<html${htmlAttributes}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="moss-html-version" content="${MOSS_HTML_DOCUMENT_VERSION}">
<title>${escapeHtml(title)}</title>
${extraHeadHtml ? `${extraHeadHtml}\n` : ''}</head>
<body${bodyAttributes}>
${innerHtml}
</body>
</html>`;
}

export function createDefaultMossHtmlDocument(): string {
  return buildMossHtmlDocument({
    extraHeadHtml: DEFAULT_DOCUMENT_HEAD_HTML
  });
}

export function isCanonicalMossHtmlDocument(rawHtml: string): boolean {
  return DOCUMENT_VERSION_META_RE.test(rawHtml);
}

export interface MossHtmlDocumentCanonicalization {
  rawHtml: string;
  didUpgrade: boolean;
  width: number;
  height: number;
  preview: MossHtmlPreviewDescriptor;
}

export function canonicalizeMossHtmlDocument(
  rawHtml: string,
  options: MossHtmlDocumentOptions = {}
): MossHtmlDocumentCanonicalization {
  const nextInnerHtml = options.innerHtml ?? extractBodyInnerHtml(rawHtml);
  const extractedTitle = options.title?.trim() || extractTitle(rawHtml) || DEFAULT_DOCUMENT_TITLE;
  const preservedTitle = extractedTitle === LEGACY_GENERATED_ARTIFACT_TITLE &&
    rawHtml.includes(`<h1>${LEGACY_GENERATED_ARTIFACT_TITLE}</h1>`)
    ? DEFAULT_DOCUMENT_TITLE
    : extractedTitle;
  const nextRawHtml = buildMossHtmlDocument({
    title: preservedTitle,
    innerHtml: nextInnerHtml,
    extraHeadHtml: options.extraHeadHtml ?? extractPreservedHeadHtml(rawHtml),
    htmlAttributes: options.htmlAttributes ?? extractTagAttributes(rawHtml, 'html'),
    bodyAttributes: options.bodyAttributes ?? extractTagAttributes(rawHtml, 'body')
  });
  const intrinsicSize = resolveMossHtmlIntrinsicSize(nextRawHtml);

  return {
    rawHtml: nextRawHtml,
    didUpgrade: nextRawHtml !== rawHtml.trim(),
    width: intrinsicSize.width,
    height: intrinsicSize.height,
    preview: describeMossHtmlPreview(nextRawHtml)
  };
}
