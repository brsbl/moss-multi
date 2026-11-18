import type { ReactNode } from 'react';

/**
 * One notice in the inbox, under its note: what happened, a muted time, and while unread a small neutral dot in moss's
 * ink (never an accent colour). `note` explains a notice whose target could not be opened.
 */
export function InboxItem({ children, time, unread, note }: { children: ReactNode; time: string; unread: boolean; note?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span aria-hidden className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${unread ? 'bg-ink-muted' : 'bg-transparent'}`} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`min-w-0 flex-1 whitespace-normal break-words text-xs leading-4 ${unread ? 'text-ink-default' : 'text-ink-muted'}`}>{children}</span>
          <span className="shrink-0 whitespace-nowrap text-micro text-ink-faint">{time}</span>
        </span>
        {note ? <span className="mt-0.5 block whitespace-normal text-micro text-ink-muted">{note}</span> : null}
      </span>
    </span>
  );
}
