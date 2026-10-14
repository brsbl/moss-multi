// HTML blocks and srcDoc previews on the web (A§16, SP13): moss renders them as `data:` iframes, which inherit the
// page's nonce CSP and so never run their scripts. apps/web points them at its /frame/html document instead, which
// is sandboxed to `allow-scripts` alone (an opaque origin), and posts the HTML in once the frame says it is ready.
// Hosts that serve no frame document leave it unset and keep moss's behavior; the viewer resolves one per viewer.
import { HTML_FRAME_CONTENT, HTML_FRAME_PATH, HTML_FRAME_READY, HTML_FRAME_RUN, HTML_FRAME_SANDBOX } from '@moss-multi/protocol/html-frame';

let frameSrc: string | null = null;

/** apps/web's boot turns live frames on. */
export function enableFrameDocument(src: string | null = HTML_FRAME_PATH): void {
  frameSrc = src;
}

type FrameResolver = (noteId: string) => string | null | undefined;
let resolver: FrameResolver | null = null;

/** A host that serves a frame document per note (the viewer, per mounted viewer); undefined falls back to the page's. */
export function resolveFrameDocument(resolve: FrameResolver | null): void {
  resolver = resolve;
}

/** The frame document a note's srcDoc iframes load, or null to keep moss's data: URL. */
export function htmlFrameSrc(noteId?: string | null): string | null {
  const own = noteId && resolver ? resolver(noteId) : undefined;
  return own === undefined ? frameSrc : own;
}

export const HTML_FRAME_IFRAME_SANDBOX = HTML_FRAME_SANDBOX;

let sandboxProbe: DOMTokenList | null = null;

/**
 * `sandbox` without the flags this engine does not know (WebKit rejects moss's `allow-presentation` with a console
 * error). Dropping a flag only takes a permission away, never grants one.
 */
export function supportedSandbox(sandbox: string): string {
  if (typeof document === 'undefined') return sandbox;
  sandboxProbe ??= document.createElement('iframe').sandbox;
  const probe = sandboxProbe;
  if (typeof probe.supports !== 'function') return sandbox;
  return sandbox.split(/\s+/).filter((token) => token && probe.supports(token)).join(' ');
}

/** Where a frame belongs: its note, and the moss block it previews when moss names one (a portalled frame too). */
export interface FrameScope {
  noteId?: string | null;
  block?: string | null;
}

/**
 * Per-block consent to run scripts (the editor, PRODUCT ruling 21). With a gate, CONTENT carries `run` and a block
 * runs only once the gate allows it; the frame document asks with RUN when the user presses its Run button. Without
 * one (apps/web, the viewer), CONTENT has no `run` and the frame document runs the block at once.
 */
export interface FrameRunGate {
  allowed(iframe: HTMLIFrameElement, scope: FrameScope): boolean;
  allow(iframe: HTMLIFrameElement, scope: FrameScope): void;
}

let runGate: FrameRunGate | null = null;

export function gateFrameScripts(gate: FrameRunGate | null): void {
  runGate = gate;
}

const fed = new Set<() => void>();

/** Sends `html` into `iframe` once its frame document announces itself; returns the listener's cleanup. */
export function feedHtmlFrame(iframe: HTMLIFrameElement, html: string, scope: FrameScope = {}): () => void {
  // The frame is an opaque origin, so no target origin can name it.
  const send = () =>
    iframe.contentWindow?.postMessage(
      runGate ? { type: HTML_FRAME_CONTENT, html, run: runGate.allowed(iframe, scope) } : { type: HTML_FRAME_CONTENT, html },
      '*',
    );
  // Run in another frame of the same block allows this one too; a frame already running ignores a second CONTENT.
  const refresh = () => {
    if (runGate?.allowed(iframe, scope)) send();
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === HTML_FRAME_READY) send();
    else if (type === HTML_FRAME_RUN && runGate) {
      runGate.allow(iframe, scope);
      for (const other of fed) other();
    }
  };
  window.addEventListener('message', onMessage);
  fed.add(refresh);
  return () => {
    window.removeEventListener('message', onMessage);
    fed.delete(refresh);
  };
}
