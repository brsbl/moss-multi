// The input-refusal notice (A§19 `data-input-refusal`): one polite live region, always mounted so screen readers
// hear each refusal below the top bar. An empty band occupies no layout space.
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
      className="pointer-events-none flex shrink-0 items-center justify-center px-3"
    >
      {message ? (
        <span className="rounded-md border border-border-subtle bg-surface-raised-card px-3 py-1.5 text-xs text-ink-default ">
          {message}
        </span>
      ) : null}
    </div>
  );
}
