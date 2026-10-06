// @vitest-environment jsdom
// T5.1: a Suggest mount on a real DocSession, its requests answered by the real ingest over a fake doc socket. A
// record closed while the socket is down reaches the author in the new socket's sync step 2, before 'sync'; the
// session must still settle `data-sync-unacked` so the pane can remount.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestRequest } from '@moss-multi/protocol/suggest';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { recordIds } from '../../../../../../packages/sync/src/suggest/records.ts';
import { nodeRegistry } from '../../../../../../packages/sync/src/suggest/review.ts';
import { deterministicIds, seededBody, select, SUGGESTER } from '../../../../../../packages/sync/src/suggest/test-support.ts';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static CLOSING = 2;
  readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  constructor(readonly url: string) { super(); sockets.push(this); }
  send(frame: unknown) { this.sent.push(frame); }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  ended(code: number) { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code })); }
}
vi.stubGlobal('WebSocket', FakeSocket);
const { DocSession } = await import('../doc-session.ts');
const { SuggestMount } = await import('./mounts.ts');
const { clearTerminal } = await import('../terminal.ts');
const latest = () => sockets[sockets.length - 1];

let restore: () => void = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  clearTerminal('doc');
  restore = deterministicIds();
});
afterEach(() => { restore(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('a record closed while offline, arriving in sync step 2 with requests still owed, settles unacked after the resync', async () => {
  const live = seededBody();
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
  const session = new DocSession('doc');
  await session.provider.connect();
  const who = { ...SUGGESTER, role: 'suggester', connection: 'c1' };
  // What the DocDO has that the author's B lacks, applied as the provider applies a sync frame.
  const catchUp = () => Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(session.doc)), session.provider);
  let read = 0;
  const pending = (socket: FakeSocket): SuggestRequest[] => {
    const frames = socket.sent.filter((frame): frame is string => typeof frame === 'string' && frame.includes('"suggest-'));
    const fresh = frames.slice(read).map((frame) => JSON.parse(frame.slice('__YPS:'.length)) as SuggestRequest);
    read = frames.length;
    return fresh;
  };
  // The DocDO stores each request, broadcasts what changed, then replies.
  const answer = (socket: FakeSocket, requests: SuggestRequest[]) => {
    for (const request of requests) {
      const reply = handleSuggest(ingest, who, request);
      catchUp();
      socket.dispatchEvent(new MessageEvent('message', { data: `__YPS:${JSON.stringify(reply)}` }));
    }
  };

  const first = latest();
  first.open();
  catchUp();
  session.provider.synced = true;
  const mount = new SuggestMount(session, SUGGESTER.id, { ready() {}, refused() {}, rebuild() {}, closed() {}, change() {} });
  const bound = bindEditor(mount.fork.doc);
  try {
    void mount.provider.connect();
    answer(first, pending(first));
    expect(mount.fork.ready, 'F is filled once its lease arrives').toBe(true);
    bound.editor.update(() => {}, { discrete: true });
    const type = (step: () => void) => {
      bound.editor.update(() => {}, { discrete: true });
      bound.editor.update(step, { discrete: true });
      bound.editor.update(() => {}, { discrete: true });
    };
    type(() => select('Hello', 24).insertText(' One.'));
    type(() => select('Hello', 29).insertText(' Two.'));
    const requests = pending(first);
    expect(requests.map((request) => request.t)).toEqual(['suggest-ops', 'suggest-ops']);
    // One reply arrives while the other request is still in flight.
    answer(first, requests.slice(0, 1));
    expect(session.state.unacked).toBe(true);
    const [record] = recordIds(live);

    // The socket drops; meanwhile another of the author's windows withdraws the record.
    first.ended(1006);
    expect(ingest.withdraw({ ...who, connection: 'c2' }, record)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = latest();
    expect(second).not.toBe(first);
    read = 0;
    who.connection = 'c3';
    second.open();
    // Sync step 2 lands before 'sync': the fork sees its record closed with a request still owed.
    catchUp();
    expect(mount.fork.closed, 'input closes').toBe(true);
    session.provider.synced = true;
    answer(second, pending(second));
    expect(session.state.unacked, 'nothing is owed by a closed fork, so the pane can remount').toBe(false);
  } finally {
    bound.dispose();
    mount.dispose();
    session.dispose();
  }
});
