// What a closed suggestion could not keep (docs/design/suggestions.md §5 refusal path), as a card in the pane's bottom
// region (T9.41). Each closed suggestion's text is its own payload with Copy, Show text and Dismiss; it stays until
// that payload is dismissed, whatever else the pane shows meanwhile, and nothing here applies it to the note.
import { SUGGEST_UNSAVED_ATTR } from '@moss-multi/protocol/dom-contract';
import { AlertTriangle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Banner } from '../../../../../../packages/ui/src/Banner.tsx';
import { NOTICE_ACTION, NOTICE_DISMISS } from '../../notice-stack.ts';
import { dismissUnsaved, useNoSuggestionRoom, useUnsaved, type UnsavedPayload } from './mode.ts';

type Copy = 'idle' | 'copied' | 'failed';

const textOf = (payload: UnsavedPayload): string => payload.blocks.join('\n\n');

/** One payload's actions: Copy (said only once the clipboard took it), Show text, and Dismiss, which drops only it. */
function PayloadActions({ docId, payload, copy, onCopy, shown, onShow, copyLabel }: {
  docId: string; payload: UnsavedPayload; copy: Copy; onCopy: (copy: Copy) => void; shown: boolean; onShow: (shown: boolean) => void; copyLabel: string;
}): ReactNode {
  const failed = () => {
    onCopy('failed');
    onShow(true);
  };
  return (
    <>
      <button
        type="button"
        className={NOTICE_ACTION}
        onClick={() => {
          const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
          if (!clipboard) {
            failed();
            return;
          }
          clipboard.writeText(textOf(payload)).then(() => onCopy('copied'), failed);
        }}
      >
        {copy === 'copied' ? 'Copied' : copyLabel}
      </button>
      <button type="button" aria-expanded={shown} className={NOTICE_ACTION} onClick={() => onShow(!shown)}>
        {shown ? 'Hide text' : 'Show text'}
      </button>
      <button type="button" className={NOTICE_DISMISS} onClick={() => dismissUnsaved(docId, payload.id)}>
        Dismiss
      </button>
    </>
  );
}

/** A payload's full text as typed, selectable so it can be copied by hand when the clipboard refuses. */
function PayloadText({ payload, copy }: { payload: UnsavedPayload; copy: Copy }): ReactNode {
  return (
    <>
      {copy === 'failed' ? <p role="alert" className="mb-1 text-xs text-ink-muted">Couldn’t copy. Select the text to copy it.</p> : null}
      <pre className="max-h-40 w-full max-w-xl select-text overflow-auto whitespace-pre-wrap break-words rounded bg-surface-canvas px-2 py-1.5 font-sans text-xs text-ink-default">
        {textOf(payload)}
      </pre>
    </>
  );
}

const timeOf = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function UnsavedCard({ docId, extra }: { docId: string; extra?: ReactNode }): ReactNode {
  const payloads = useUnsaved(docId);
  const full = useNoSuggestionRoom(docId);
  const [copies, setCopies] = useState<Record<number, Copy>>({});
  const [shown, setShown] = useState<Record<number, boolean>>({});
  if (payloads.length === 0 && !full) return null;
  const copyOf = (payload: UnsavedPayload): Copy => copies[payload.id] ?? 'idle';
  const actions = (payload: UnsavedPayload, copyLabel: string): ReactNode => (
    <PayloadActions
      docId={docId}
      payload={payload}
      copy={copyOf(payload)}
      copyLabel={copyLabel}
      onCopy={(copy) => setCopies((all) => ({ ...all, [payload.id]: copy }))}
      shown={shown[payload.id] ?? false}
      onShow={(next) => setShown((all) => ({ ...all, [payload.id]: next }))}
    />
  );
  const message = full
    ? `This note has no room for more suggestions${payloads.length ? ', so your last changes were not saved' : ''}. An editor can still edit it.`
    : payloads.length > 1
      ? `${payloads.length} suggestions were closed while you typed, so those changes were not saved.`
      : 'This suggestion was closed while you typed, so your last changes were not saved.';
  const icon = <AlertTriangle aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent-terracotta/80" />;
  const attrs = { [SUGGEST_UNSAVED_ATTR]: '', role: 'alert' };
  if (payloads.length === 0) {
    const dismiss = <button type="button" className={NOTICE_DISMISS} onClick={() => dismissUnsaved(docId)}>Dismiss</button>;
    return <Banner {...attrs} icon={icon} action={<>{dismiss}{extra}</>}>{message}</Banner>;
  }
  if (payloads.length === 1) {
    const only = payloads[0];
    const detail = shown[only.id] ? <PayloadText payload={only} copy={copyOf(only)} /> : undefined;
    return <Banner {...attrs} icon={icon} action={<>{actions(only, 'Copy what wasn’t saved')}{extra}</>} detail={detail}>{message}</Banner>;
  }
  const list = (
    <ul className="flex flex-col gap-1.5">
      {payloads.map((payload, index) => (
        <li key={payload.id} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-ink-faint">Suggestion {index + 1} · {timeOf(payload.at)}</span>
            {actions(payload, 'Copy')}
          </div>
          {shown[payload.id] ? <PayloadText payload={payload} copy={copyOf(payload)} /> : null}
        </li>
      ))}
    </ul>
  );
  return <Banner {...attrs} icon={icon} action={extra} detail={list}>{message}</Banner>;
}
