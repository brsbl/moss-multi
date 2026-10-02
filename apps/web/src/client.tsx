import { CLIENT_BUILD_ATTR } from '@moss-multi/protocol/dom-contract';
import { StartClient } from '@tanstack/react-start/client';
import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { BUILD } from './provenance.ts';

// Stamped before React mounts (A§4.3); T0.5a puts Prism, fonts and moss styles ahead of it.
document.documentElement.setAttribute(CLIENT_BUILD_ATTR, `${BUILD.commit}:${BUILD.clientHash}`);

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
