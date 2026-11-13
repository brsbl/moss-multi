// The host's way into moss's feedback pill (CanvasAreaContent showActionFeedback, seam action-feedback): a pane
// showing the note listens, and a host action confirms itself there the way moss confirms its own (T9.4).

export interface ActionFeedback {
  type: 'success' | 'error';
  message: string;
  position?: 'top' | 'bottom';
  action?: { label: string; onClick: () => void };
}

type Show = (feedback: ActionFeedback) => void;

const panes = new Map<string, Set<Show>>();

/** A pane showing `noteId` takes its feedback; returns the unsubscriber. */
export function subscribeActionFeedback(noteId: string, show: Show): () => void {
  const set = panes.get(noteId) ?? new Set<Show>();
  panes.set(noteId, set);
  set.add(show);
  return () => {
    set.delete(show);
    if (set.size === 0 && panes.get(noteId) === set) panes.delete(noteId);
  };
}

/** Shows `feedback` in every pane showing `noteId`; false when none does. */
export function showActionFeedback(noteId: string, feedback: ActionFeedback): boolean {
  const set = panes.get(noteId);
  if (!set?.size) return false;
  for (const show of [...set]) show(feedback);
  return true;
}
