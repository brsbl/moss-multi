# @moss-multi/viewer

## 1.0.0

API version 1, unchanged except for one optional service.

- **No mutating control in read-only.** Hovering a block shows no Delete, Edit HTML, Fullscreen, Draw, comment or
  insert-paragraph control. Code and chart selectors render disabled, as in the editor's read-only view.
- **X posts follow the viewer's theme.** A post loads with `theme=light` or `theme=dark` from `options.theme` and
  re-renders on `setTheme`. The host page's own theme is untouched.
- **moss-html runs live** when the host passes `services.htmlFrameUrl`: each HTML block runs in
  `<iframe sandbox="allow-scripts">` loading that URL, an opaque origin that cannot reach the page. A double-click
  opens no source editor. Without the service, HTML blocks show moss's cached screenshot through `assetUrl`, as in
  0.2.0.
- **Every node family is styled** as in the editor's read-only view (headings, lists, tasks, formulas, wiki links,
  pills, colors, quotes, tables, callouts, tabs, code, charts, sketches, HTML).
- **Video** loads through `assetUrl`; the URL must answer HTTP Range requests with 206.
- The package is public and packs for release with `viewer.json`, a SHA-256 of the tarball and the source commit.

### What a host newly provides

- Optional `services.htmlFrameUrl`: serve `dist/moss-viewer-frame.html` with the response header
  `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`
  (loosen `img-src`, `font-src` or `connect-src` only for what notes' HTML may load), and allow that URL in the
  page's `frame-src`.
- X posts load from `https://platform.twitter.com`, so the page's `frame-src` must allow it, as in 0.2.0.
