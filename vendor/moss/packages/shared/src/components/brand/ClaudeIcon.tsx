// ported-from: packages/shared/src/components/brand/ClaudeIcon.tsx @ 762abb777
import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Claude AI asterisk/sunburst symbol.
 * 11 tapered rays radiating from center, matching the official mark.
 * Renders as an inline SVG styled via className (color, size).
 * Default size matches lucide icon conventions (h-4 w-4 = 16px).
 */
export function ClaudeIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn('h-4 w-4', className)}
      aria-hidden
      {...props}
    >
      <circle cx="12" cy="12" r="1.8" />
      <path d="M11.55,10.26 L11.05,2.55 L12.95,2.55 L12.45,10.26 Z M12.57,10.29 L16.31,3.54 L17.91,4.56 L13.32,10.77 Z M13.40,10.87 L20.20,7.21 L20.99,8.94 L13.77,11.68 Z M13.79,11.81 L21.49,12.41 L21.22,14.28 L13.66,12.69 Z M13.61,12.81 L19.76,17.47 L18.52,18.91 L13.03,13.48 Z M12.92,13.55 L15.57,20.80 L13.75,21.34 L12.06,13.80 Z M11.94,13.80 L10.25,21.34 L8.43,20.80 L11.08,13.55 Z M10.97,13.48 L5.48,18.91 L4.24,17.47 L10.39,12.81 Z M10.34,12.69 L2.78,14.28 L2.51,12.41 L10.21,11.81 Z M10.23,11.68 L3.01,8.94 L3.80,7.21 L10.60,10.87 Z M10.68,10.77 L6.09,4.56 L7.69,3.54 L11.43,10.29 Z" />
    </svg>
  );
}
