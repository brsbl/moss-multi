// Client entry, in moss main.tsx's order (A§4.3): Prism first, then moss's prism-setup, then hydration. Fonts and
// moss's styles.css load ahead of this script through the root route's stylesheet, in the same order.
import './host/prism-global.ts';
import '@moss-desktop/renderer/editor/plugins/code-block/prism-setup';

import { CLIENT_BUILD_ATTR } from '@moss-multi/protocol/dom-contract';
import { StartClient } from '@tanstack/react-start/client';
import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { installClientProtocol } from './host/client-protocol.ts';
import { BUILD } from './provenance.ts';

// Stamped before React mounts.
document.documentElement.setAttribute(CLIENT_BUILD_ATTR, `${BUILD.commit}:${BUILD.clientHash}`);
// Before anything fetches: every API call names this bundle's client protocol (rule 10).
installClientProtocol();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
