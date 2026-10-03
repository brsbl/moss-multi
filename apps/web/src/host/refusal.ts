// The one input-refusal notice (A§0 #2, A§19 `data-input-refusal`): an input the web cannot take is refused visibly,
// never dropped silently. Host code and vendored seams call refuseInput; RefusalAnnouncer renders the message.
// It occupies the reserved notice band under the top bar.

const SHOWN_MS = 4_000;

/** A pasted or dropped image or video while uploads are staged (media-upload, T3.1). */
export const MEDIA_UPLOAD_REFUSED = "Images and video can't be uploaded on the web yet.";

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
