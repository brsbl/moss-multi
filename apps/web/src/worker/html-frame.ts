// The HTML-block frame (SP13, A§22 default). A data: iframe inherits the page CSP, whose script-src carries a
// per-request nonce, so a moss-html block's own scripts never run there. Blocks load this document instead: its
// policy is only `sandbox allow-scripts`, so it is an opaque origin with no access to the app, and it writes the
// block's HTML that the embedding page posts to it.

export const HTML_FRAME_PATH = '/frame/html';
export const HTML_FRAME_POLICY = 'sandbox allow-scripts';

/** Messages between the page and the frame. */
export const HTML_FRAME_READY = 'moss-html-frame-ready';
export const HTML_FRAME_CONTENT = 'moss-html-frame-content';

const BOOTSTRAP = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function onContent(event) {
  if (event.source !== parent || !event.data || event.data.type !== '${HTML_FRAME_CONTENT}') return;
  removeEventListener('message', onContent);
  document.open();
  document.write(String(event.data.html));
  document.close();
});
parent.postMessage({ type: '${HTML_FRAME_READY}' }, '*');
</script>`;

export function htmlFrameResponse(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method-not-allowed' }), { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'application/json' } });
  }
  return new Response(request.method === 'HEAD' ? null : BOOTSTRAP, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': HTML_FRAME_POLICY,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}
