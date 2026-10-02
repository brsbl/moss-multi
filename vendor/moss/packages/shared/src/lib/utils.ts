// ported-from: packages/shared/src/lib/utils.ts @ 762abb777
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/* The Tailwind config extends fontSize with custom keys (h1–h4, body, small,
 * caption, code, detail, micro, nano). tailwind-merge doesn't know about
 * these by default, so combining e.g. a base `text-sm` with a consumer
 * `text-micro` leaves both classes on the element and the stock Tailwind
 * size wins. Register them as font-size classes so cn() deduplicates them
 * against the standard text-* utilities. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        'text-h1',
        'text-h2',
        'text-h3',
        'text-h4',
        'text-body',
        'text-small',
        'text-caption',
        'text-code',
        'text-detail',
        'text-micro',
        'text-nano'
      ]
    }
  }
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
