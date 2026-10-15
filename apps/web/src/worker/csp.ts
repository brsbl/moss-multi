// The page content security policy (A§4.3). Start's SSR injects per-request inline scripts, so scripts carry a
// nonce minted per request instead of a static hash. A data: iframe inherits this policy (SP13), so HTML blocks
// run from the same-origin /frame/html document (frame-src 'self'); data: stays for moss's other frames.

export function mintNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(nonce: string, requestUrl: string): string {
  const { protocol, host } = new URL(requestUrl);
  const socket = `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${socket}`,
    "frame-src 'self' data: https:",
    "img-src 'self' data: https: blob:",
    "media-src 'self' blob:",
    // A same-site page gets the session cookie in a frame (A§18), so only the app frames its pages.
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Sets the policy on an HTML document; other responses pass through untouched. */
export function withCsp(response: Response, nonce: string, requestUrl: string): Response {
  if (!(response.headers.get('content-type') ?? '').startsWith('text/html')) return response;
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', contentSecurityPolicy(nonce, requestUrl));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
