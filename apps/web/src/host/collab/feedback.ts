// The host's way into moss's feedback pill (CanvasAreaContent showActionFeedback, seam action-feedback): a pane
// showing the note listens, and a host action confirms itself there the way moss confirms its own (T9.4).

export interface ActionFeedback {
  type: 'success' | 'error';
  message: string;
  position?: 'top' | 'bottom';
  action?: { label: string; onClick: () => void };
}

type Show = (feedback: ActionFeedback) => void;
/** Clears the pill if it still shows `message`. */
type Withdraw = (message: string) => void;
interface Listener { show: Show; withdraw?: Withdraw }

const panes = new Map<string, Set<Listener>>();

/** A pane showing `noteId` takes its feedback; returns the unsubscriber. */
export function subscribeActionFeedback(noteId: string, show: Show, withdraw?: Withdraw): () => void {
  const set = panes.get(noteId) ?? new Set<Listener>();
  panes.set(noteId, set);
  const listener: Listener = { show, withdraw };
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && panes.get(noteId) === set) panes.delete(noteId);
  };
}

/** Takes `message` down early in every pane showing `noteId` that still shows it (a raise's pill, lowered again). */
export function withdrawActionFeedback(noteId: string, message: string): void {
  for (const { withdraw } of [...(panes.get(noteId) ?? [])]) withdraw?.(message);
}

/** Shows `feedback` in every pane showing `noteId`; false when none does. */
export function showActionFeedback(noteId: string, feedback: ActionFeedback): boolean {
  const set = panes.get(noteId);
  if (!set?.size) return false;
  for (const { show } of [...set]) show(feedback);
  return true;
}
