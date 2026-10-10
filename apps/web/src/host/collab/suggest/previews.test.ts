// @vitest-environment jsdom
// T5.S8: the Suggestions panel asks for previews only for cards on screen, a few at a time, keeps them across
// reopenings, and waits out a 429's Retry-After before asking again.
import type { SuggestionRecord } from '@moss-multi/core/suggest/apply';
import { SUGGESTION_CARD_ATTR, SUGGESTION_ID_ATTR } from '@moss-multi/protocol/dom-contract';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../access.ts', () => ({ useDocRole: () => 'editor' }));
vi.mock('../../auth.ts', () => ({ useAuthState: () => ({ status: 'signed-in', user: { id: 'me' } }) }));
vi.mock('../../surfaces/NotificationsBell.tsx', () => ({ timeAgo: () => 'Just now' }));

const { SuggestionList } = await import('./SuggestionsPanel.tsx');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = (id: string, at: number): SuggestionRecord => ({
  meta: { v: 2, id, author: 'ada', authorName: 'Ada', source: 'live', createdAt: at, updatedAt: at, status: 'open', clients: [7] },
  ops: [],
  parts: [],
});

/** IntersectionObserver as the test decides: `show` reports cards entering or leaving the panel's scroll box. */
class FakeObserver {
  static all = new Set<FakeObserver>();
  readonly targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.all.add(this);
  }
  observe(element: Element) {
    this.targets.add(element);
  }
  unobserve(element: Element) {
    this.targets.delete(element);
  }
  disconnect() {
    FakeObserver.all.delete(this);
  }
  takeRecords() {
    return [];
  }
}

async function show(ids: string[], visible = true): Promise<void> {
  await act(async () => {
    for (const observer of [...FakeObserver.all]) {
      for (const target of observer.targets) {
        if (!ids.includes(target.getAttribute(SUGGESTION_ID_ATTR) ?? '')) continue;
        observer.callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
      }
    }
  });
}

interface Pending {
  id: string;
  answer: (status: number, body: unknown, retryAfter?: string) => void;
}
let pending: Pending[] = [];
let requested: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  requested = [];
  inFlight = 0;
  maxInFlight = 0;
  FakeObserver.all.clear();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const id = decodeURIComponent(/suggestions\/([^/]+)\/preview$/.exec(url)?.[1] ?? '');
    requested.push(id);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => {
      pending.push({
        id,
        answer: (status, body, retryAfter) => {
          inFlight -= 1;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
            headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
          });
        },
      });
    });
  }));
});

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(docId: string, records: SuggestionRecord[]): Promise<Root> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(SuggestionList, { docId, open: records, reviewed: [], me: 'me', role: 'editor', active: null })));
  return root;
}

const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

const ready = (id: string) => ({ preview: { hunks: [], hash: `hash-${id}`, digest: `digest-${id}` } });

/** Answers every request as it arrives, until none is left. */
async function answerAll(): Promise<void> {
  for (let guard = 0; guard < 100 && pending.length; guard += 1) {
    const next = pending.shift()!;
    await act(async () => next.answer(200, ready(next.id)));
    await advance(0);
  }
}

const card = (id: string) => document.querySelector(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_ID_ATTR}="${id}"]`) as HTMLElement;
const acceptOf = (id: string) => [...card(id).querySelectorAll('button')].find((button) => button.textContent?.includes('Accept')) as HTMLButtonElement;

it('previews are requested only for cards on screen, two at a time @p:mean-2 @p:R17', async () => {
  const records = Array.from({ length: 10 }, (_, i) => record(`r${i}`, 1000 - i));
  await render('doc-visible', records);
  await advance(1000);
  expect(requested).toEqual([]);

  await show(['r0', 'r1', 'r2', 'r3', 'r4']);
  await advance(300);
  expect(requested.length).toBe(2);
  await answerAll();
  expect([...requested].sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  expect(maxInFlight).toBeLessThanOrEqual(2);
  expect(card('r0').textContent).toContain('No visible change yet.');
  expect(card('r9').textContent).toContain('Loading changes');

  // A card scrolled past before its turn costs nothing; the next one on screen is asked for.
  await show(['r5']);
  await show(['r5'], false);
  await show(['r9']);
  await advance(300);
  await answerAll();
  expect(requested.slice(5)).toEqual(['r9']);
});

it('reopening the panel shows the kept previews without asking again @p:mean-2 @p:R17', async () => {
  const records = [record('a', 3), record('b', 2), record('c', 1)];
  const first = await render('doc-reopen', records);
  await show(['a', 'b', 'c']);
  await advance(300);
  await answerAll();
  expect([...requested].sort()).toEqual(['a', 'b', 'c']);

  act(() => first.unmount());
  roots = roots.filter((root) => root !== first);
  await render('doc-reopen', records);
  expect(card('a').textContent).toContain('No visible change yet.');
  expect(card('a').textContent).not.toContain('Loading changes');
  await show(['a', 'b', 'c']);
  await advance(1000);
  expect(requested.length).toBe(3);
  expect(acceptOf('b').disabled).toBe(false);
});

it('a 429 waits out its Retry-After, then the card loads and Accept works @p:mean-2 @p:R17', async () => {
  await render('doc-429', [record('x', 1), record('y', 0)]);
  await show(['x', 'y']);
  await advance(300);
  expect(requested.length).toBe(2);
  await act(async () => pending.shift()!.answer(429, { error: 'rate-limited' }, '30'));
  await act(async () => pending.shift()!.answer(429, { error: 'rate-limited' }, '30'));
  await advance(0);
  expect(card('x').textContent).toContain('Too many reviews at once');
  expect(acceptOf('x').disabled).toBe(true);

  await advance(29_000);
  expect(requested.length).toBe(2);
  await advance(1_500);
  expect(requested.length).toBe(4);
  await answerAll();
  expect(card('x').textContent).toContain('No visible change yet.');
  expect(acceptOf('x').disabled).toBe(false);
  expect(acceptOf('y').disabled).toBe(false);
});
