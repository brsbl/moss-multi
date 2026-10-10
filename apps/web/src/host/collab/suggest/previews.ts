// Suggestion previews for the panel's cards (T5.S8). A preview costs one token of the reader's budget
// (SUGGEST_PREVIEW_RATE), so only a card on screen, expanded or active asks for one, at most PREVIEW_CONCURRENCY run at
// once, an answer is kept per record digest across panel reopenings, and a 429 pauses every request until its
// Retry-After has passed, then the waiting cards are asked for again.
import type { Hunk } from '@moss-multi/core/suggest/apply';
import { useEffect, useState, useSyncExternalStore } from 'react';

export type Preview = { state: 'loading' } | { state: 'ready'; hunks: Hunk[]; hash: string; digest: string } | { state: 'failed'; reason: string };

export interface PreviewAnswer {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
  retryAfter: string | null;
}

export type PreviewFetcher = (docId: string, id: string) => Promise<PreviewAnswer>;

/** Preview requests in flight at once. */
export const PREVIEW_CONCURRENCY = 2;
/** A card waits this long before asking, so an author still typing costs one preview per pause. */
export const PREVIEW_DEBOUNCE_MS = 250;
/** The pause after a 429 without a usable Retry-After (the server's window). */
const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 5 * 60_000;

const LOADING: Preview = { state: 'loading' };

interface Entry {
  readonly docId: string;
  readonly id: string;
  /** Bumped by refresh: the body moved under the preview. */
  round: number;
  /** The key the reader wants now (`digest:round`). */
  want: string;
  /** The key an answer has settled (a 429 settles nothing). */
  fetched: string | null;
  /** The key the shown value answers. */
  shown: string | null;
  value: Preview;
  wanters: number;
  inflight: boolean;
}

/** Seconds or an HTTP date, as Retry-After allows; DEFAULT_PAUSE_MS when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  const text = header?.trim() ?? '';
  let ms = NaN;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else if (text) ms = Date.parse(text) - now;
  if (!Number.isFinite(ms)) return DEFAULT_PAUSE_MS;
  return Math.min(MAX_PAUSE_MS, Math.max(1000, ms));
}

export function createPreviewLoader(fetcher: PreviewFetcher) {
  const entries = new Map<string, Entry>();
  const pending = new Set<Entry>();
  const listeners = new Set<() => void>();
  let active = 0;
  let pausedUntil = 0;
  let resume: ReturnType<typeof setTimeout> | null = null;
  let version = 0;

  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const entryOf = (docId: string, id: string): Entry => {
    const name = `${docId}\u0000${id}`;
    let entry = entries.get(name);
    if (!entry) {
      entry = { docId, id, round: 0, want: '', fetched: null, shown: null, value: LOADING, wanters: 0, inflight: false };
      entries.set(name, entry);
    }
    return entry;
  };

  const pump = () => {
    const now = Date.now();
    if (now < pausedUntil) {
      resume ??= setTimeout(() => {
        resume = null;
        pump();
      }, pausedUntil - now);
      return;
    }
    for (const entry of pending) {
      if (active >= PREVIEW_CONCURRENCY) return;
      pending.delete(entry);
      // A card that scrolled away or closed before its turn is asked for again when it is back.
      // One in flight answers first, then asks again if the record moved meanwhile.
      if (entry.inflight || entry.wanters === 0 || entry.fetched === entry.want) continue;
      void run(entry, entry.want);
    }
  };

  const run = async (entry: Entry, key: string) => {
    active += 1;
    entry.inflight = true;
    const answer = await fetcher(entry.docId, entry.id).catch((): PreviewAnswer | null => null);
    active -= 1;
    entry.inflight = false;
    if (answer?.status === 429) {
      pausedUntil = Math.max(pausedUntil, Date.now() + retryAfterMs(answer.retryAfter));
      entry.shown = key;
      entry.value = { state: 'failed', reason: 'rate-limited' };
      pending.add(entry);
    } else {
      const shown = answer?.json.preview as { hunks: Hunk[]; hash: string; digest: string } | undefined;
      entry.fetched = key;
      entry.shown = key;
      entry.value = answer?.ok && shown ? { state: 'ready', ...shown } : { state: 'failed', reason: String(answer?.json.error ?? 'unavailable') };
      // The record changed while this one was in flight: ask again for the newer one.
      if (entry.want !== key) pending.add(entry);
    }
    changed();
    pump();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
    /** The preview for `digest` of the record, or loading when none has been settled for it. */
    get(docId: string, id: string, digest: string): Preview {
      const entry = entryOf(docId, id);
      return entry.shown === `${digest}:${entry.round}` ? entry.value : LOADING;
    },
    /** Asks for the record's preview at `digest` while the returned release has not been called. */
    want(docId: string, id: string, digest: string): () => void {
      const entry = entryOf(docId, id);
      entry.wanters += 1;
      entry.want = `${digest}:${entry.round}`;
      if (entry.fetched !== entry.want) {
        pending.add(entry);
        pump();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.wanters -= 1;
      };
    },
    /** Asks again (the note changed since the preview, or the reader retries a failure). */
    refresh(docId: string, id: string, digest: string): void {
      const entry = entryOf(docId, id);
      entry.round += 1;
      entry.want = `${digest}:${entry.round}`;
      changed();
      if (entry.wanters > 0) {
        pending.add(entry);
        pump();
      }
    },
  };
}

export type PreviewLoader = ReturnType<typeof createPreviewLoader>;

/** The record's preview from `loader`, asked for while `wanted` holds (after the debounce). */
export function useLoadedPreview(loader: PreviewLoader, docId: string, id: string, digest: string, wanted: boolean): [Preview, () => void] {
  useSyncExternalStore(loader.subscribe, loader.version, loader.version);
  const preview = loader.get(docId, id, digest);
  useEffect(() => {
    if (!wanted) return;
    let release: (() => void) | null = null;
    const timer = setTimeout(() => {
      release = loader.want(docId, id, digest);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      release?.();
    };
  }, [loader, docId, id, digest, wanted]);
  return [preview, () => loader.refresh(docId, id, digest)];
}

/** Whether `element` shows inside `root` (the panel's scroll box); always true where IntersectionObserver is missing. */
export function useOnScreen(root: Element | null): [(element: Element | null) => void, boolean] {
  const [element, setElement] = useState<Element | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!element || !root) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((records) => {
      for (const record of records) if (record.target === element) setVisible(record.isIntersecting);
    }, { root });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, root]);
  return [setElement, visible];
}
