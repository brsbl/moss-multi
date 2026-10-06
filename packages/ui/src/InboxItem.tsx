import type { ReactNode } from 'react';

/** One notice in the bell's inbox: an unread dot, what happened, and when; moss's ink and accent tokens. */
export function InboxItem({ children, time, unread }: { children: ReactNode; time: string; unread: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2 py-0.5">
      <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${unread ? 'bg-accent-brand' : 'bg-transparent'}`} />
      <span className="min-w-0 flex-1">
        <span className={`block whitespace-normal break-words text-xs leading-snug ${unread ? 'font-medium text-ink-default' : 'text-ink-muted'}`}>{children}</span>
        <span className="mt-0.5 block text-micro text-ink-faint">{time}</span>
      </span>
    </span>
  );
}

/** The bell's count: nothing at zero, then the number, capped at 9+. */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-accent-brand px-1 text-nano font-semibold leading-none text-ink-on-accent">
      {count > 9 ? '9+' : count}
    </span>
  );
}
