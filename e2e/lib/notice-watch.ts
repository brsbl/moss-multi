// One notice on a note, at every moment (T9.50a). Installed before a trash, a MutationObserver records, from the first
// moment the page holds a Trash notice or a connection card, every later moment it holds none or more than one. A
// retrying count waits through such a moment; this does not.
import type { Page } from '@playwright/test';
import { NAMES } from './contract.ts';

/** A moment the page did not hold exactly one notice: ms since the watch began, and how many it held. */
export interface NoticeGap {
  at: number;
  count: number;
}

const KEY = '__e2eNoticeWatch';

/** Starts watching `page`; `stop` ends the watch and returns every moment it recorded. */
export async function watchNotices(page: Page): Promise<{ stop: () => Promise<NoticeGap[]> }> {
  await page.evaluate(({ key, attrs }) => {
    const selector = attrs.map((attr) => `[${attr}]`).join(', ');
    const start = performance.now();
    const gaps: { at: number; count: number }[] = [];
    let seen = false;
    let last = 0;
    const check = () => {
      const count = document.querySelectorAll(selector).length;
      if (count === last) return;
      last = count;
      if (count > 0) seen = true;
      if (seen && count !== 1) gaps.push({ at: Math.round(performance.now() - start), count });
    };
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: attrs });
    check();
    (window as unknown as Record<string, unknown>)[key] = () => {
      check();
      observer.disconnect();
      return gaps;
    };
  }, { key: KEY, attrs: [NAMES.retentionNotice, NAMES.connectionBanner] });
  return {
    stop: () => page.evaluate((key) => ((window as unknown as Record<string, () => { at: number; count: number }[]>)[key])(), KEY),
  };
}
