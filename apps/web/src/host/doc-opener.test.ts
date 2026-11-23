// @vitest-environment jsdom
// A notice opens its note in place once the server says it may (T9.46). The access answer can be slow, so a note the
// user chose meanwhile wins, and a pane already showing the note is not taken for the open until that answer lands.
import { BODY_BINDING_ATTR, DOC_ID_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR } from '@moss-multi/protocol/dom-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge, inertBrowser } from './bridge/index.ts';
import { openDoc } from './navigation.ts';
import { openNotice, type Notice } from './notifications.ts';

const docs = ['a', 'b', 'c'].map((id) => ({ id, title: id.toUpperCase(), createdAt: 1, updatedAt: 1, trashedAt: null }));

/** A bridge whose `GET /api/docs/:id` answers only when the test says so. */
function tab() {
  const answers = new Map<string, (response: Response) => void>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    const doc = /^\/api\/docs\/([^/?]+)$/.exec(url)?.[1];
    if (doc) return new Promise<Response>((resolve) => answers.set(doc, resolve));
    return Response.json({ vault: { id: 'v1', name: 'Home' }, docs });
  });
  const api = createBridge({ pathname: () => '/', fetch, browser: inertBrowser });
  const opened: string[] = [];
  const off = api.notes.onInternalFileOpen((id: string) => { opened.push(id); });
  const answer = (id: string, response: Response) => {
    const send = answers.get(id);
    if (!send) throw new Error(`no read of ${id} is pending`);
    answers.delete(id);
    send(response);
  };
  const allow = (id: string) => answer(id, Response.json({ role: 'editor', doc: { ...docs.find((d) => d.id === id), folderId: 'root' } }));
  return { api, opened, off, answer, allow, pending: (id: string) => answers.has(id) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 10; i += 1) await tick(); };

/** moss reports the panes, then the focused note, once its switch has rendered. */
async function show(api: ReturnType<typeof createBridge>, focused: string) {
  await tick();
  await api.notes.setOpenFileWatchTargets([focused]);
  await api.system.setFocusedNoteId(focused);
}

const notice = (id: string): Notice => ({
  id: `n-${id}`, type: 'mention', read: false, createdAt: 1, by: 'Ada', target: { type: 'doc', id, title: id.toUpperCase(), kind: 'doc' },
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('a notice opening its note (T9.46)', () => {
  it('drops an open whose access answer lands after the user chose another note', async () => {
    const t = tab();
    await show(t.api, 'c');
    const markRead = vi.fn();
    const unreachable = vi.fn();
    const opening = openNotice(notice('a'), { open: (n) => openDoc(n.target.id), markRead, unreachable });
    await settle();
    expect(t.pending('a'), 'the open waits on the access read').toBe(true);
    // The user picks B in the sidebar while A's read is still out.
    await show(t.api, 'b');
    t.allow('a');
    await settle();
    expect(t.opened, 'B stays: the late answer for A does not switch to it').toEqual([]);
    await opening;
    expect(markRead, 'A was never reached').not.toHaveBeenCalled();
    expect(unreachable, 'A is not said to be gone: the user only moved on').not.toHaveBeenCalled();
    t.off();
  });

  it('lets a second notice opened while the first is still asking win', async () => {
    const t = tab();
    await show(t.api, 'c');
    void openDoc('a');
    await settle();
    void openDoc('b');
    await settle();
    t.allow('b');
    await settle();
    expect(t.opened).toEqual(['b']);
    t.allow('a');
    await settle();
    expect(t.opened, 'the earlier notice, answered last, does not replace B').toEqual(['b']);
    t.off();
  });

  it('does not count a pane already showing the note as opened before the access answer says no', async () => {
    const t = tab();
    await show(t.api, 'a');
    const pane = document.createElement('div');
    pane.setAttribute(EDITOR_PANE_ATTR, '');
    pane.setAttribute(DOC_ID_ATTR, 'a');
    pane.setAttribute(DOC_STATE_ATTR, 'live');
    const body = document.createElement('div');
    body.setAttribute(BODY_BINDING_ATTR, 'live');
    pane.append(body);
    document.body.append(pane);
    const markRead = vi.fn();
    const unreachable = vi.fn();
    const opening = openNotice(notice('a'), { open: (n) => openDoc(n.target.id), markRead, unreachable });
    await settle();
    expect(markRead, 'not read before the server answers').not.toHaveBeenCalled();
    t.answer('a', new Response(null, { status: 404 }));
    await opening;
    expect(markRead).not.toHaveBeenCalled();
    expect(unreachable).toHaveBeenCalledWith('n-a');
    t.off();
  });
});
