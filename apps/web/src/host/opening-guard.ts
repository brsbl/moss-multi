// The "+ Note" opening guard (A§9, R2). Moss awaits the create round trip with focus still on its trigger, then
// focuses the body once it binds, so keys typed in between went to the button (Space or Enter made another note) or
// nowhere. The App seam arms this as "+ Note" runs: the trigger is blurred, and until a live field takes focus every
// printable key, Space, Enter and Backspace aimed at no editable is consumed and announced as "Opening note…".

import { BODY_BINDING_ATTR, TITLE_BINDING_ATTR } from '@moss-multi/protocol/dom-contract';
import { refuseInput, settleRefusal } from './refusal.ts';

export const OPENING_NOTE = 'Opening note…';
/** After the create, a bind that never comes leaves typing to the page again; the doc state says why (T1.3). */
const MAX_UNBOUND_MS = 30_000;
const LIVE_FIELD = `[${BODY_BINDING_ATTR}="live"], [${TITLE_BINDING_ATTR}="live"]`;

let current: (() => void) | null = null;

const isLiveField = (target: EventTarget | null): boolean => target instanceof Element && target.closest(LIVE_FIELD) !== null;

/** An input, textarea or editable root still takes its own keys (the notes search, a live field). */
const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

const isTyping = (event: KeyboardEvent): boolean =>
  !event.metaKey && !event.ctrlKey && !event.altKey && (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace');

export interface OpeningGuard {
  /** The create failed or was abandoned: keys go back to the page now. */
  disarm(): void;
  /** The note exists and is opening: the guard holds until a live field takes focus, or MAX_UNBOUND_MS. */
  created(): void;
}

/** Arms the guard (replacing an earlier one); it holds for as long as the create is pending. */
export function armOpeningGuard(): OpeningGuard {
  current?.();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || !isTyping(event) || isEditable(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    refuseInput(OPENING_NOTE);
  };
  const onFocusIn = (event: FocusEvent): void => {
    if (isLiveField(event.target)) disarm();
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  function disarm(): void {
    if (current !== disarm) return;
    current = null;
    if (timer) clearTimeout(timer);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('focusin', onFocusIn, true);
    settleRefusal(OPENING_NOTE);
  }

  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);
  current = disarm;
  return {
    disarm,
    created() {
      if (current === disarm && !timer) timer = setTimeout(disarm, MAX_UNBOUND_MS);
    },
  };
}
