import { createRouter } from '@tanstack/react-router';
import { getGlobalStartContext } from '@tanstack/react-start';
import { routeTree } from './routeTree.gen';

/**
 * The request's CSP nonce (SP13): server.ts mints it and passes it as Start's request context; the router stamps it
 * on every script it renders. The client reads it back from the csp-nonce meta the router emits.
 */
function requestNonce(): string | undefined {
  if (!import.meta.env.SSR) return undefined;
  try {
    return (getGlobalStartContext() as { nonce?: string } | undefined)?.nonce;
  } catch {
    return undefined;
  }
}

export function getRouter() {
  const nonce = requestNonce();
  return createRouter({ routeTree, scrollRestoration: true, ...(nonce ? { ssr: { nonce } } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
