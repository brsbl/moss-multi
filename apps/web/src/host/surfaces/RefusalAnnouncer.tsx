// The input-refusal notice (A§19 `data-input-refusal`): one polite live region, always mounted so screen readers
// hear each refusal. It sits in the pane's one bottom region (T9.35), and a refusal shows there as Moss's floating
// bottom notice at its content's width, so the note under the top bar never moves.
import { INPUT_REFUSAL_ATTR } from '@moss-multi/protocol/dom-contract';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Banner } from '../../../../../packages/ui/src/Banner.tsx';
import { refusalMessage, subscribeRefusal } from '../refusal.ts';

export const useRefusalMessage = (): string => useSyncExternalStore(subscribeRefusal, refusalMessage, () => '');

export function RefusalAnnouncer(): ReactNode {
  const message = useRefusalMessage();
  return (
    <div {...{ [INPUT_REFUSAL_ATTR]: '' }} role="status" aria-live="polite" className="pointer-events-none flex max-w-full justify-center">
      {message ? <Banner role={undefined}>{message}</Banner> : null}
    </div>
  );
}
