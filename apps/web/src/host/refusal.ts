// The one input-refusal notice (A§0 #2, A§19 `data-input-refusal`): an input the web cannot take is refused visibly,
// never dropped silently. Host code and vendored seams call refuseInput; RefusalAnnouncer renders the message.
// It occupies the reserved notice band under the top bar.

const SHOWN_MS = 4_000;

let message = '';
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function show(next: string, ms: number | null): void {
  if (timer) clearTimeout(timer);
  timer = ms === null ? null : setTimeout(() => show('', null), ms);
  if (next === message) return;
  message = next;
  for (const listener of listeners) listener();
}

/** Announces that an input was refused; the notice clears on its own. */
export function refuseInput(text: string): void {
  show(text, SHOWN_MS);
}

/** A refusal already announced; a caller that logs failures (moss's upload paths) leaves it out. */
export class AnnouncedRefusal extends Error {}

/** Announces `text` and returns the error to throw, so moss's own catch sees a failure. */
export function announceRefusal(text: string): AnnouncedRefusal {
  refuseInput(text);
  return new AnnouncedRefusal(text);
}

/** Lets `text`, if it is still shown, clear sooner: its cause has passed. */
export function settleRefusal(text: string, ms = 1_200): void {
  if (message === text) show(text, ms);
}

export const refusalMessage = (): string => message;

export function subscribeRefusal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
