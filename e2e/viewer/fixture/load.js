// Load timing (T3.12): imports the built viewer, mounts the note the test put in `window.__load` (an init script) and
// records on the page's clock (ms since navigation start) when the bundle evaluated, when the note's content painted
// and when the viewer said it was ready.
const spec = window.__load;
const result = { marks: {}, bridge: [], errors: [], editable: false };
window.loadResult = result;
const mark = (name) => {
  result.marks[name] ??= performance.now();
};
window.addEventListener('error', (event) => result.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => result.errors.push(String(event.reason)));
const frame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

function watchPaint(root, probe) {
  const check = () => {
    if (!root.textContent.includes(probe)) return false;
    mark('contentInDom');
    void frame().then(() => mark('paint'));
    return true;
  };
  if (check()) return;
  const observer = new MutationObserver(() => {
    if (check()) observer.disconnect();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true });
}

async function run() {
  mark('fixtureScript');
  const root = document.getElementById('viewer');
  watchPaint(root, spec.probe);
  const viewer = await import('/viewer/moss-viewer.js');
  mark('imported');
  mark('mount');
  const handle = viewer.mountMossViewer(root, { markdown: spec.markdown, theme: 'light', noteId: spec.noteId, services: { assetUrl: () => null, notes: () => [] } });
  await handle.ready;
  mark('ready');
  for (let i = 0; i < 300 && result.marks.paint === undefined; i += 1) await frame();
  await document.fonts.ready;
  mark('fonts');
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
