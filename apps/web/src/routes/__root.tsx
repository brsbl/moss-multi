import { BUILD_META } from '@moss-multi/protocol/dom-contract';
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { buildMeta } from '../provenance.ts';
import mossIcon from '../../../../vendor/moss/logos/moss-sprout-icon.png';
import appCss from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'moss' }],
    // Global CSS belongs to the root; a lazily imported stylesheet ships an unstyled production build.
    // The icon link keeps browsers from requesting a missing /favicon.ico.
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/png', href: mossIcon },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
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
