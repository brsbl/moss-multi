// The HTML-block frame (A§4.1, A§16; SP13): a same-origin document whose only policy is `sandbox allow-scripts`, so
// it runs as an opaque origin. The embedding page waits for READY from the frame, then posts CONTENT with the block's
// HTML, which the frame writes into itself.

export const HTML_FRAME_PATH = '/frame/html';
export const HTML_FRAME_POLICY = 'sandbox allow-scripts';
/** The iframe attribute, equal to the policy: never `allow-same-origin`, since the document is same-origin. */
export const HTML_FRAME_SANDBOX = 'allow-scripts';
export const HTML_FRAME_READY = 'moss-html-frame-ready';
export const HTML_FRAME_CONTENT = 'moss-html-frame-content';
/** The user pressed Run in a block's frame (the editor's frame document only). */
export const HTML_FRAME_RUN = 'moss-html-frame-run';

/**
 * Runs first in the editor's block document (HTML_FRAME_ISOLATED_DOCUMENT), called with the block's HTML. CSP leaves
 * two paths open there, and this closes them before any block script runs:
 * - WebRTC (ICE to a STUN or TURN server): every RTC interface is deleted from the realm.
 * - Child frames, each a fresh realm with WebRTC (srcdoc and javascript: frames load under `frame-src 'none'`): the
 *   block's HTML is parsed by DOMParser, which attaches no declarative shadow root, frames and connection hints
 *   are removed before it is moved in, and a MutationObserver over the document and every shadow root removes any
 *   frame added later, before it loads. document.write and setHTMLUnsafe, which would parse declarative shadow
 *   roots, are replaced or removed.
 * Scripts are re-created so they run, in order, while the document is still loading.
 */
const HTML_FRAME_GUARD = `function (html) {
  var apply = Reflect.apply;
  var globals = Object.getOwnPropertyNames(window);
  for (var g = 0; g < globals.length; g++) if (/^(webkit)?RTC/.test(globals[g])) { try { delete window[globals[g]]; } catch (e) {} }
  function get(proto, name) { return Object.getOwnPropertyDescriptor(proto, name).get; }
  var docAll = Document.prototype.querySelectorAll, fragAll = DocumentFragment.prototype.querySelectorAll;
  var listLength = get(NodeList.prototype, 'length'), remove = Element.prototype.remove;
  var observe = MutationObserver.prototype.observe, attachShadow = Element.prototype.attachShadow;
  var parser = new DOMParser(), parse = DOMParser.prototype.parseFromString;
  var createElementNS = Document.prototype.createElementNS, createComment = Document.prototype.createComment;
  var root = get(Document.prototype, 'documentElement'), head = get(Document.prototype, 'head'), body = get(Document.prototype, 'body');
  var current = get(Document.prototype, 'currentScript'), namespace = get(Element.prototype, 'namespaceURI');
  var attributes = get(Element.prototype, 'attributes'), mapLength = get(NamedNodeMap.prototype, 'length');
  var attrName = get(Attr.prototype, 'name'), attrValue = get(Attr.prototype, 'value'), setAttribute = Element.prototype.setAttribute;
  var text = get(Node.prototype, 'textContent'), setText = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').set;
  var firstChild = get(Node.prototype, 'firstChild'), appendChild = Node.prototype.appendChild;
  var replaceElement = Element.prototype.replaceWith, replaceComment = CharacterData.prototype.replaceWith;
  var join = Array.prototype.join;
  var FRAMES = 'iframe,frame,frameset,object,embed,fencedframe,portal';
  var HINTS = 'link[rel~="preconnect" i],link[rel~="dns-prefetch" i],link[rel~="prerender" i]';
  var shadows = [];
  function strip(found) { for (var i = 0, n = apply(listLength, found, []); i < n; i++) apply(remove, found[i], []); }
  function sweep() {
    strip(apply(docAll, document, [FRAMES]));
    for (var s = 0; s < shadows.length; s++) strip(apply(fragAll, shadows[s], [FRAMES]));
  }
  var observer = new MutationObserver(sweep);
  var subtree = { childList: true, subtree: true };
  apply(observe, observer, [document, subtree]);
  Element.prototype.attachShadow = function () {
    var shadow = apply(attachShadow, this, arguments);
    shadows[shadows.length] = shadow;
    apply(observe, observer, [shadow, subtree]);
    return shadow;
  };
  function copyAttributes(from, to) {
    if (!from || !to) return;
    var attrs = apply(attributes, from, []);
    for (var i = 0, n = apply(mapLength, attrs, []); i < n; i++) apply(setAttribute, to, [apply(attrName, attrs[i], []), apply(attrValue, attrs[i], [])]);
  }
  function move(from, to) {
    if (!from || !to) return;
    for (var child = apply(firstChild, from, []); child; child = apply(firstChild, from, [])) apply(appendChild, to, [child]);
  }
  function insert(markup) {
    var parsed = apply(parse, parser, [String(markup), 'text/html']);
    strip(apply(docAll, parsed, [FRAMES + ',' + HINTS]));
    var scripts = apply(docAll, parsed, ['script']), pending = [];
    for (var i = 0, n = apply(listLength, scripts, []); i < n; i++) {
      var mark = apply(createComment, parsed, ['']);
      pending[i] = [mark, scripts[i]];
      apply(replaceElement, scripts[i], [mark]);
    }
    copyAttributes(apply(root, parsed, []), apply(root, document, []));
    copyAttributes(apply(head, parsed, []), apply(head, document, []));
    copyAttributes(apply(body, parsed, []), apply(body, document, []));
    move(apply(head, parsed, []), apply(head, document, []));
    move(apply(body, parsed, []), apply(body, document, []));
    for (var p = 0; p < pending.length; p++) {
      var old = pending[p][1];
      var fresh = apply(createElementNS, document, [apply(namespace, old, []), 'script']);
      copyAttributes(old, fresh);
      apply(setText, fresh, [apply(text, old, [])]);
      apply(replaceComment, pending[p][0], [fresh]);
    }
  }
  var documents = [Document.prototype];
  if (typeof HTMLDocument === 'function') documents[1] = HTMLDocument.prototype;
  for (var d = 0; d < documents.length; d++) {
    documents[d].write = function () { insert(apply(join, arguments, [''])); };
    documents[d].writeln = function () { insert(apply(join, arguments, ['']) + '\\n'); };
    documents[d].open = function () { return this; };
    documents[d].close = function () {};
  }
  var unsafe = [[Element.prototype, 'setHTMLUnsafe'], [ShadowRoot.prototype, 'setHTMLUnsafe'], [Document, 'parseHTMLUnsafe']];
  for (var u = 0; u < unsafe.length; u++) { try { delete unsafe[u][0][unsafe[u][1]]; } catch (e) {} }
  apply(remove, apply(current, document, []), []);
  insert(html);
}`;

/**
 * The editor's frame document (API 2), served with editor.json `htmlFrame.policy`. CONTENT carries `run`: a block
 * runs only when the host says so (PRODUCT ruling 21), and until then it renders inert, in a child sandboxed without
 * scripts, under a Run button. Pressing Run asks the host (RUN); the host records the choice and sends CONTENT again
 * with `run: true`. A running block is one level down too, in a sandboxed srcdoc child that HTML_FRAME_GUARD
 * prepares, so this document's `frame-src 'none'` governs the block's own navigations: it cannot load another URL
 * into its frame, and the sandbox keeps it from navigating this document or the page. A block that tries is torn
 * down. Only moss's size requests and reports pass between the block and the page.
 */
export const HTML_FRAME_ISOLATED_DOCUMENT = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;font:16px/1.4 system-ui,-apple-system,sans-serif}
iframe{display:block;border:0;width:100%;height:100%}
button{position:fixed;right:12px;bottom:12px;padding:6px 16px;border:1px solid rgba(0,0,0,.25);border-radius:999px;background:#fff;color:#1f1f1f;font:600 20px/1.4 system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.2)}
p{margin:0;padding:24px;color:#555;font-size:22px}
[hidden]{display:none}
</style><button type="button" title="Run this block's scripts" hidden>Run</button><p hidden>This block tried to open another page and was stopped.</p><script>
var html = null, block = null, running = false, stopped = false;
var button = document.querySelector('button'), notice = document.querySelector('p');
function show(run) {
  if (block) block.remove();
  running = run;
  block = document.createElement('iframe');
  block.setAttribute('sandbox', run ? 'allow-scripts' : '');
  block.srcdoc = run
    ? '<!doctype html><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><body><script>(' +
      ${JSON.stringify(HTML_FRAME_GUARD)} + ')(' + JSON.stringify(html).replace(/</g, '\\\\u003c') + ');<\\/script>'
    : html;
  document.body.insertBefore(block, button);
  button.hidden = run;
}
// The only navigation this document's policy refuses is its child's: the block tried to leave.
document.addEventListener('securitypolicyviolation', function (event) {
  if (event.effectiveDirective !== 'frame-src' || stopped) return;
  stopped = true;
  if (block) block.remove();
  block = null;
  button.hidden = true;
  notice.hidden = false;
});
button.addEventListener('click', function (event) {
  if (event.isTrusted && !running && !stopped) parent.postMessage({ type: '${HTML_FRAME_RUN}' }, '*');
});
addEventListener('message', function (event) {
  var data = event.data;
  if (!data || typeof data !== 'object') return;
  if (block && event.source === block.contentWindow) {
    if (running && data.type === 'moss-html-rendered-size') parent.postMessage(data, '*');
    return;
  }
  if (event.source !== parent || stopped) return;
  if (data.type === 'moss-html-measure-request') {
    if (block && running) block.contentWindow.postMessage(data, '*');
  } else if (data.type === '${HTML_FRAME_CONTENT}') {
    if (html === null) {
      html = String(data.html);
      show(data.run === true);
    } else if (data.run === true && !running) show(true);
  }
});
parent.postMessage({ type: '${HTML_FRAME_READY}' }, '*');
</script>`;

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
