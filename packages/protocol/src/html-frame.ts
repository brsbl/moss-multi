// The HTML-block frame (A§4.1, A§16; SP13): a same-origin document whose only policy is `sandbox allow-scripts`, so
// it runs as an opaque origin. The embedding page waits for READY from the frame, then posts CONTENT with the block's
// HTML, which the frame writes into itself.

export const HTML_FRAME_PATH = '/frame/html';
export const HTML_FRAME_POLICY = 'sandbox allow-scripts';
/** The iframe attribute, equal to the policy: never `allow-same-origin`, since the document is same-origin. */
export const HTML_FRAME_SANDBOX = 'allow-scripts';
export const HTML_FRAME_READY = 'moss-html-frame-ready';
export const HTML_FRAME_CONTENT = 'moss-html-frame-content';

/** The frame document: it announces itself, then writes the first CONTENT its parent posts. */
export const HTML_FRAME_DOCUMENT = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function onContent(event) {
  if (event.source !== parent || !event.data || event.data.type !== '${HTML_FRAME_CONTENT}') return;
  removeEventListener('message', onContent);
  document.open();
  document.write(String(event.data.html));
  document.close();
});
parent.postMessage({ type: '${HTML_FRAME_READY}' }, '*');
</script>`;
