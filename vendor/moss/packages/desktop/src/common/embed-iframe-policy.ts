// ported-from: packages/desktop/src/common/embed-iframe-policy.ts @ 762abb777
/**
 * Shared iframe sandbox / referrer / loading / allow policy by risk profile.
 *
 * This module is React-free so common, main, and renderer code can share one
 * maintenance point for iframe policy. The four profiles intentionally differ
 * by source type and risk; see docs and the W1 plan note for the rationale
 * (notably: `local-html-preview` keeps `allow-same-origin`, which the current
 * `HtmlPreviewIframe` relies on to avoid blank Electron renders).
 */

export type EmbedIframeRiskProfile =
  | 'local-html-preview'
  | 'remote-oembed-preview'
  | 'remote-social-embed'
  | 'remote-video'
  | 'remote-webpage';

export type EmbedIframeReferrerPolicy =
  | 'no-referrer'
  | 'no-referrer-when-downgrade'
  | 'origin'
  | 'origin-when-cross-origin'
  | 'same-origin'
  | 'strict-origin'
  | 'strict-origin-when-cross-origin'
  | 'unsafe-url';

export interface EmbedIframePolicy {
  riskProfile: EmbedIframeRiskProfile;
  sandbox: string;
  referrerPolicy?: EmbedIframeReferrerPolicy;
  loading?: 'lazy' | 'eager';
  allow?: string;
  allowFullScreen?: boolean;
}

const EMBED_IFRAME_POLICIES: Record<EmbedIframeRiskProfile, EmbedIframePolicy> = {
  'local-html-preview': {
    riskProfile: 'local-html-preview',
    // Existing local moss-html preview policy. `allow-same-origin` is required:
    // Electron's sandboxed renderer paints data-URL/srcDoc previews blank
    // without it. Asserted in html-node-active-inactive.test.tsx.
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'
  },
  'remote-oembed-preview': {
    riskProfile: 'remote-oembed-preview',
    // Sandboxed oEmbed-HTML preview (tweets, etc.). No `allow-popups`: the
    // preview has no rendering need for `window.open`, matching the
    // remote-webpage rationale and limiting the auto-loaded nested-iframe seam.
    sandbox: 'allow-scripts'
  },
  'remote-social-embed': {
    riskProfile: 'remote-social-embed',
    // Official social widgets (currently Twitter/X) render through their own
    // nested iframe. `allow-same-origin` is required so the provider-owned
    // nested frame can initialize normally instead of being forced into an
    // opaque origin; links may open via the provider widget chrome.
    sandbox: 'allow-scripts allow-same-origin allow-popups',
    referrerPolicy: 'strict-origin-when-cross-origin',
    loading: 'lazy'
  },
  'remote-video': {
    riskProfile: 'remote-video',
    sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups',
    allow: 'autoplay; fullscreen',
    allowFullScreen: true
  },
  'remote-webpage': {
    riskProfile: 'remote-webpage',
    // Live remote webpage embeds run in an OPAQUE (unique) origin: no
    // `allow-same-origin`, so SCRIPTS inside the frame cannot read the framed
    // site's own cookies/localStorage/authenticated session. Note the opaque
    // origin does NOT strip cookies from the frame's own network requests — the
    // initial navigation and sub-resources still send the site's cookies,
    // including SameSite=None ones; the real protection against most ambient
    // CSRF is the browser's SameSite=Lax default. (Future hardening: load these
    // frames in a dedicated cookieless `session`/partition.) No `allow-popups`
    // (no rendering need; window.open is already bounded by
    // setWindowOpenHandler). The blank-render issue that requires
    // `allow-same-origin` is data:/srcDoc-specific and only applies to
    // `local-html-preview`; remote sites that refuse opaque-origin framing fall
    // through to the click-to-load timeout fallback instead.
    sandbox: 'allow-scripts allow-forms',
    referrerPolicy: 'strict-origin-when-cross-origin',
    loading: 'lazy'
  }
};

/** Returns a fresh copy of the policy for the given risk profile. */
export function getEmbedIframePolicy(riskProfile: EmbedIframeRiskProfile): EmbedIframePolicy {
  return { ...EMBED_IFRAME_POLICIES[riskProfile] };
}
