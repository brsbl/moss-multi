// The sidebar footer's Settings target, home of the app menu and its inbox (T9.30). A cue that leaves the top bar
// while it had focus hands focus here, or to the notes-panel toggle while the sidebar is put away.
import { TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { useCallback, useRef, type ComponentType, type ReactNode, type Ref } from 'react';

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

/**
 * A ref for a top-bar cue: when the cue leaves the page while it holds focus, focus goes to `home()` instead of the
 * page. React detaches the ref before it removes the node, so the check sees where focus was; the move waits until
 * the node is really gone (a ref merely re-attached keeps its focus) and never takes focus from anything else.
 */
export function useFocusHome(home: () => HTMLElement | null): (el: HTMLElement | null) => void {
  const node = useRef<HTMLElement | null>(null);
  const target = useRef(home);
  target.current = home;
  return useCallback((el: HTMLElement | null) => {
    if (el) {
      node.current = el;
      return;
    }
    const left = node.current;
    node.current = null;
    if (!left?.contains(document.activeElement)) return;
    queueMicrotask(() => {
      if (left.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      target.current()?.focus();
    });
  }, []);
}

/** Moss's TooltipTrigger, typed to take the ref `useFocusHome` gives: its asChild drops a child's own ref. */
export const HomeTrigger = TooltipTrigger as unknown as ComponentType<{ asChild?: boolean; children: ReactNode; ref?: Ref<HTMLElement> }>;
