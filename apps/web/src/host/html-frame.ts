// HTML blocks and srcDoc previews on the web (A§16, SP13): moss renders them as `data:` iframes, which inherit the
// page's nonce CSP and so never run their scripts. apps/web points them at its /frame/html document instead, which
// is sandboxed to `allow-scripts` alone (an opaque origin), and posts the HTML in once the frame says it is ready.
// Hosts that serve no frame document (the viewer) leave it unset and keep moss's behavior.
import { HTML_FRAME_CONTENT, HTML_FRAME_PATH, HTML_FRAME_READY, HTML_FRAME_SANDBOX } from '@moss-multi/protocol/html-frame';

let frameSrc: string | null = null;

/** apps/web's boot turns live frames on. */
export function enableFrameDocument(src: string | null = HTML_FRAME_PATH): void {
  frameSrc = src;
}

/** The frame document srcDoc iframes load, or null to keep moss's data: URL. */
export const htmlFrameSrc = (): string | null => frameSrc;

export const HTML_FRAME_IFRAME_SANDBOX = HTML_FRAME_SANDBOX;

/** Sends `html` into `iframe` once its frame document announces itself; returns the listener's cleanup. */
export function feedHtmlFrame(iframe: HTMLIFrameElement, html: string): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || (event.data as { type?: unknown } | null)?.type !== HTML_FRAME_READY) return;
    // The frame is an opaque origin, so no target origin can name it.
    iframe.contentWindow?.postMessage({ type: HTML_FRAME_CONTENT, html }, '*');
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
