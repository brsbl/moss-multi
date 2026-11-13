// A restore of an open note, as this tab hears it (T9.4). Someone else's restore stays named in the pane's band until
// dismissed; this tab's own restores are confirmed in moss's feedback pill instead, so their event is set aside while
// the tab's own restore is in flight and dropped once its answer names the same restore point.
import { useSyncExternalStore } from 'react';

export interface RestoredNotice {
  by: string;
  point: string | null;
}

const notices = new Map<string, RestoredNotice>();
const own = new Map<string, { inFlight: number; points: Set<string | null>; held: RestoredNotice[] }>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

const ownOf = (docId: string) => {
  let entry = own.get(docId);
  if (!entry) own.set(docId, (entry = { inFlight: 0, points: new Set(), held: [] }));
  return entry;
};

/** The DocDO's `restored` event for `docId`. */
export function heardRestore(docId: string, notice: RestoredNotice): void {
  const mine = own.get(docId);
  if (mine && mine.inFlight > 0) {
    mine.held.push(notice);
    return;
  }
  if (mine?.points.has(notice.point)) return;
  notices.set(docId, notice);
  changed();
}

/** This tab starts a restore of `docId`; the returned finish takes the restore point its answer named, or undefined on a refusal. */
export function beginOwnRestore(docId: string): (point?: string | null) => void {
  const mine = ownOf(docId);
  mine.inFlight += 1;
  let done = false;
  return (point) => {
    if (done) return;
    done = true;
    mine.inFlight -= 1;
    if (point !== undefined) mine.points.add(point);
    if (mine.inFlight > 0) return;
    const held = mine.held.splice(0);
    for (const notice of held) heardRestore(docId, notice);
  };
}

export function dismissRestoreNotice(docId: string): void {
  if (notices.delete(docId)) changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useRestoreNotice(docId: string | null): RestoredNotice | null {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return docId === null ? null : (notices.get(docId) ?? null);
}
