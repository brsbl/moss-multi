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
