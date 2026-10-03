// The input-refusal notice (A§19 `data-input-refusal`): one polite live region, always mounted so screen readers
// hear each refusal, in the reserved notice band below the top bar.
import { INPUT_REFUSAL_ATTR } from '@moss-multi/protocol/dom-contract';
import { useSyncExternalStore, type ReactNode } from 'react';
import { refusalMessage, subscribeRefusal } from '../refusal.ts';

export function RefusalAnnouncer(): ReactNode {
  const message = useSyncExternalStore(subscribeRefusal, refusalMessage, () => '');
  return (
    <div
      {...{ [INPUT_REFUSAL_ATTR]: '' }}
      role="status"
      aria-live="polite"
      className="pointer-events-none text-xs text-ink-default"
    >
      {message ? (
        <span className="block border-b border-border-subtle bg-surface-raised-card px-4 py-2">
          {message}
        </span>
      ) : null}
    </div>
  );
}
