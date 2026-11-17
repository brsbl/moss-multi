// The sidebar footer's Settings target, home of the app menu and its inbox (T9.30). A cue that leaves the top bar
// while it had focus hands focus here, or to the notes-panel toggle while the sidebar is put away.
export const APP_MENU_ATTR = 'data-app-menu';

const shown = (el: HTMLElement): boolean => el.getClientRects().length > 0 && !el.closest('[inert], [aria-hidden="true"]');

/** The footer's Settings while it is on screen, else the notes-panel toggle in `bar`, else null. */
export function footerDestination(bar: HTMLElement | null): HTMLElement | null {
  const footer = document.querySelector<HTMLElement>(`[${APP_MENU_ATTR}]`);
  if (footer && shown(footer)) return footer;
  const toggle = bar?.querySelector<HTMLElement>('button[aria-label="Show notes panel"]') ?? null;
  return toggle && shown(toggle) ? toggle : null;
}

/**
 * After a popup closes: if its cue (`cue`, a selector in `bar`) leaves the bar within two seconds and the person has
 * not acted meanwhile, focus, which was on the cue or in its popup, goes to `destination` instead of being lost. A
 * field the person moved to keeps it.
 */
export function handOffWhenGone(bar: HTMLElement, cue: string, destination: () => HTMLElement | null, cancelled: () => boolean = () => false): void {
  const started = performance.now();
  let acted = false;
  const act = () => { acted = true; };
  const opts = { capture: true };
  window.addEventListener('pointerdown', act, opts);
  window.addEventListener('keydown', act, opts);
  const done = () => {
    window.removeEventListener('pointerdown', act, opts);
    window.removeEventListener('keydown', act, opts);
  };
  const settle = () => {
    if (acted || cancelled()) return done();
    if (bar.querySelector(cue)) {
      if (performance.now() - started < 2_000) requestAnimationFrame(settle);
      else done();
      return;
    }
    done();
    if (document.activeElement?.closest('input, textarea, select, [contenteditable="true"]')) return;
    destination()?.focus();
  };
  requestAnimationFrame(settle);
}
