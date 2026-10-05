// The HTML-block frame (SP13, A§22 default). A data: iframe inherits the page CSP, whose script-src carries a
// per-request nonce, so a moss-html block's own scripts never run there. Blocks load this document instead: its
// policy is only `sandbox allow-scripts`, so it is an opaque origin with no access to the app, and it writes the
// block's HTML that the embedding page posts to it.

import { HTML_FRAME_DOCUMENT, HTML_FRAME_PATH, HTML_FRAME_POLICY } from '@moss-multi/protocol/html-frame';

export { HTML_FRAME_PATH };

export function htmlFrameResponse(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method-not-allowed' }), { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'application/json' } });
  }
  return new Response(request.method === 'HEAD' ? null : HTML_FRAME_DOCUMENT, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': HTML_FRAME_POLICY,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}
