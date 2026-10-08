// Load timing (T3.12): imports the built editor, mounts the note the test put in `window.__load` (an init script)
// in a fixture host, and records on the page's clock (ms since navigation start) when the bundle evaluated, when the
// note's content painted and when it was editable, plus every bridge call before ready. `latency` delays each async
// bridge call, standing in for a host whose reads cross a process boundary.
import { MemoryHost, MemoryVolume, seedNote } from '/src/testing/memory-host.js';

const spec = window.__load;
const result = { marks: {}, bridge: [], errors: [], editable: false };
window.loadResult = result;
const mark = (name) => {
  result.marks[name] ??= performance.now();
};
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => result.errors.push(String(event.reason)));
// The first keystroke that lands in the body.
document.addEventListener('input', () => mark('typed'), true);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const frame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

/** The host, with every call timed and, when `latency` is set, each async call answered that much later. */
function instrument(host, latency) {
  const wrap = (target, name, label) => {
    const call = target[name].bind(target);
    target[name] = (...args) => {
      const entry = { op: label, start: performance.now(), end: null };
      result.bridge.push(entry);
      const value = call(...args);
      if (!value || typeof value.then !== 'function') {
        entry.end = performance.now();
        return value;
      }
      return (async () => {
        if (latency) await sleep(latency);
        try {
          return await value;
        } finally {
          entry.end = performance.now();
        }
      })();
    };
  };
  for (const name of ['read', 'readCompanion', 'write']) wrap(host, name, name);
  for (const name of Object.keys(host.assets)) if (typeof host.assets[name] === 'function') wrap(host.assets, name, `assets.${name}`);
  return host;
}

/** Each block decorator's type and height, so a test can see whether a block changed size once its view loaded. */
const blocks = (root) =>
  [...root.querySelectorAll('[data-moss-note-editor-root="true"] div[data-lexical-decorator="true"]')].map((element) => ({
    text: element.textContent.slice(0, 24),
    height: Math.round(element.getBoundingClientRect().height),
  }));

/** The blocks once everything has loaded, for comparison with `paintBlocks`. */
window.settledBlocks = () => blocks(document.getElementById('editor'));

/** Marks `paint` on the frame after the body first holds the note's text. */
function watchPaint(root, probe) {
  const check = () => {
    const body = root.querySelector('[data-moss-note-editor-root="true"]');
    if (!body || !body.textContent.includes(probe)) return false;
    mark('contentInDom');
    void frame().then(() => {
      mark('paint');
      result.paintBlocks = blocks(root);
    });
    return true;
  };
  if (check()) return;
  const observer = new MutationObserver(() => {
    if (check()) observer.disconnect();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true });
}

/** A collapsed caret at the end of the body's last text, in the focused contenteditable. */
function placeCaret(root) {
  const body = root.querySelector('[data-moss-note-editor-root="true"]');
  if (!body || body.getAttribute('contenteditable') !== 'true') return false;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim()) last = node;
  if (!last) return false;
  body.focus({ preventScroll: true });
  const range = document.createRange();
  range.setStart(last, last.textContent.length);
  range.collapse(true);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return document.activeElement === body && body.contains(selection.anchorNode);
}

async function run() {
  mark('fixtureScript');
  const root = document.getElementById('editor');
  watchPaint(root, spec.probe);
  const editor = await import('/editor/moss-editor.js');
  mark('imported');
  const volume = new MemoryVolume();
  seedNote(volume, ['Notes', spec.title], {
    markdown: spec.markdown,
    meta: spec.meta,
    assets: Object.fromEntries(Object.entries(spec.assets ?? {}).map(([name, base64]) => [name, Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))])),
  });
  const host = instrument(new MemoryHost({ volume }), spec.latency ?? 0);
  host.body = root;
  mark('mount');
  const handle = editor.mountMossEditor(root, { noteId: spec.meta.id, bridge: host, theme: 'light', htmlFrameUrl: '/editor/moss-html-frame.html' });
  window.loadHandle = handle;
  await handle.ready;
  mark('ready');
  // Editable: the body is contenteditable and takes a caret, as soon as it does.
  for (let i = 0; i < 300 && !placeCaret(root); i += 1) await frame();
  if (placeCaret(root)) {
    result.editable = true;
    mark('editable');
  }
  for (let i = 0; i < 300 && result.marks.paint === undefined; i += 1) await frame();
  await document.fonts.ready;
  mark('fonts');
  result.readyBridgeCalls = result.bridge.filter((entry) => entry.start < result.marks.ready).length;
}

run().then(
  () => {
    result.done = true;
  },
  (error) => {
    result.errors.push(String(error?.stack ?? error));
    result.done = true;
  },
);
