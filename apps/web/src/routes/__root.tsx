import { BUILD_META } from '@moss-multi/protocol/dom-contract';
import { HeadContent, Scripts, ScriptOnce, createRootRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { buildMeta } from '../provenance.ts';
import mossIcon from '../../../../vendor/moss/logos/moss-sprout-icon.png';
import appCss from '../styles.css?url';

// moss's FOUC guard, verbatim from R/index.html @ 762abb777: localStorage moss_theme → html[data-theme] before
// first paint. ScriptOnce renders it with the request's CSP nonce and removes it before hydration.
const THEME_SCRIPT =
  "!function(){var c='system';try{c=localStorage.getItem('moss_theme')||'system'}catch(e){}if(c!=='system'&&c!=='light'&&c!=='dark')c='system';var m=false;try{m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches}catch(e){}document.documentElement.dataset.theme=c==='system'?(m?'dark':'light'):c}()";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'moss' }],
    // Global CSS belongs to the root; a lazily imported stylesheet ships an unstyled production build (L§4.1).
    // The icon link keeps browsers from requesting a missing /favicon.ico.
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/png', href: mossIcon },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-app-state="booting" suppressHydrationWarning>
      <head>
        <ScriptOnce>{THEME_SCRIPT}</ScriptOnce>
        <meta name={BUILD_META} content={buildMeta()} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/** The one unknown-route page: unknown paths, test hooks without their gate, and any playground path (R7). */
function NotFound() {
  return (
    <main className="flex h-full min-h-screen items-center justify-center bg-surface-panel">
      <p className="text-sm text-ink-muted">This page doesn&apos;t exist.</p>
    </main>
  );
}
