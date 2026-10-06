// The 0.2.0 host fixture: testing/memory-host.js and host/moss-editor-host.js are byte for byte the files released as
// editor-v0.2.0 (commit 31f3f26, API 1). It mounts the current bundle the way an API 1 host does and reports what it
// got back, so a test can hold the bundle to a typed mismatch at mount rather than silent misbehaviour.
import { MOSS_EDITOR_INFO, mountMossEditor } from '/editor/moss-editor.js';
import { MOSS_EDITOR_INFO as HOST_INFO } from './host/moss-editor-host.js';
import { MemoryHost, MemoryVolume, seedNote } from './testing/memory-host.js';

const plain = (value) => JSON.parse(JSON.stringify(value));

window.api1Fixture = {
  async mount(noteId, note) {
    const volume = new MemoryVolume();
    const host = new MemoryHost({ volume });
    seedNote(volume, ['Notes', note.meta.title], note);
    const before = volume.snapshot('/Moss');
    const events = [];
    const element = document.getElementById('editor');
    const handle = mountMossEditor(element, { noteId, bridge: host, onEvent: (event) => events.push(event) });
    const ready = await handle.ready.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, name: error.name, code: error.code, message: error.message }),
    );
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const placeholder = element.querySelector('[data-moss-editor-unavailable]')?.textContent ?? null;
    const status = handle.status;
    const flush = await handle.flush();
    const unmount = await handle.unmount();
    return plain({
      host: HOST_INFO,
      editor: MOSS_EDITOR_INFO,
      ready,
      status,
      placeholder,
      events: events.map(({ kind, op, status, willRetry }) => ({ kind, op, status, willRetry })),
      calls: host.calls.map(({ op }) => op),
      unchanged: JSON.stringify(volume.snapshot('/Moss')) === JSON.stringify(before),
      flush,
      unmount: { kind: unmount.kind, flush: unmount.flush.kind },
    });
  },
};
document.documentElement.dataset.fixture = 'ready';
