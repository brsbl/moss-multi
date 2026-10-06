// The fixture's host side: a MemoryHost over a MemoryVolume, seeded by the test, and one mounted editor whose
// events and handle the test reads through window.editorFixture. Every CSP violation is recorded.
import { MOSS_EDITOR_API, MOSS_EDITOR_INFO, mountMossEditor } from '/editor/moss-editor.js';
import { MemoryHost, MemoryVolume, seedNote } from '/src/testing/memory-host.js';

const violations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(`${event.violatedDirective} ${event.blockedURI}`);
});

const state = { volume: null, host: null, handle: null, events: [], shared: [] };
const plain = (value) => JSON.parse(JSON.stringify(value));

window.editorFixture = {
  api: MOSS_EDITOR_API,
  info: MOSS_EDITOR_INFO,
  violations,
  reset({ caseInsensitive = false } = {}) {
    state.volume = new MemoryVolume({ caseInsensitive });
    state.host = new MemoryHost({ volume: state.volume });
    state.events = [];
  },
  seed(segments, note) {
    return seedNote(state.volume, segments, note);
  },
  /** connect-src is 'none', so the test hands bytes over as base64. */
  seedAsset(dir, name, base64) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    state.volume.silently(() => state.volume.writeFile(`${dir}/assets/${name}`, bytes));
  },
  mount(noteId, { theme = 'light', restoreDraft, share = false } = {}) {
    document.documentElement.dataset.theme = theme;
    state.events = [];
    state.shared = [];
    const notes = () => [{ id: noteId, title: 'Plan', folderPath: 'Notes' }];
    state.handle = mountMossEditor(document.getElementById('editor'), {
      noteId,
      bridge: state.host,
      theme,
      htmlFrameUrl: '/editor/moss-html-frame.html',
      services: share ? { notes, shareWithAgent: (selection) => state.shared.push(plain(selection)) } : { notes },
      onEvent: (event) => state.events.push(plain(event)),
      ...(restoreDraft ? { restoreDraft } : {}),
    });
    return state.handle.ready.then(
      () => ({ ok: true, status: state.handle.status }),
      (error) => ({ ok: false, code: error.code, status: state.handle.status }),
    );
  },
  setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    state.handle.setTheme(theme);
  },
  async flush() {
    return plain(await state.handle.flush());
  },
  async unmount(options) {
    const result = await state.handle.unmount(options);
    return { kind: result.kind, flush: result.flush.kind };
  },
  /** The handle's selection, or 'unsupported' from an editor without `selection-1`. */
  selection() {
    return typeof state.handle?.selection === 'function' ? state.handle.selection() : 'unsupported';
  },
  /** What services.shareWithAgent was handed, in order. */
  shared() {
    return state.shared;
  },
  status() {
    return state.handle ? state.handle.status : null;
  },
  events() {
    return state.events;
  },
  files(under = '/Moss') {
    return state.volume.snapshot(under);
  },
  externalWrite(path, text) {
    state.volume.writeFile(path, text);
  },
  silentWrite(path, text) {
    state.volume.silently(() => state.volume.writeFile(path, text));
  },
  /** The URL the host issues for a note's asset, as a frame showing that note would load it. */
  assetUrl(noteId, ref) {
    return state.host.assets.url(noteId, ref, 'image');
  },
  /** Makes the host's note reads reject until turned off, as a busy disk would. */
  failReads(on) {
    const host = state.host;
    host.read = on ? async () => Promise.reject(new Error('the disk is busy')) : MemoryHost.prototype.read.bind(host);
  },
  /** Holds each host write for `ms` before it runs, so an edit can land while one is pending. */
  delayWrites(ms) {
    const host = state.host;
    const write = MemoryHost.prototype.write.bind(host);
    host.write = ms ? async (noteId, request) => (await new Promise((done) => setTimeout(done, ms)), write(noteId, request)) : write;
  },
  /** The last unmount's result, with the receipt's markdown. */
  async unmountDetail(options) {
    const result = await state.handle.unmount(options);
    return plain({ kind: result.kind, flush: result.flush.kind, markdown: result.flush.receipt?.files.markdown ?? result.flush.draft?.files.markdown ?? null });
  },
  calls() {
    return state.host.calls.map(({ write, ...call }) => (write ? { ...call, ops: write.ops.map((op) => `${op.kind}:${op.file}`) } : call));
  },
};
document.documentElement.dataset.fixture = 'ready';
