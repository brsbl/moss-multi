// The pane's notices (T9.41): one place decides which card leads the pane's bottom region, so the connection (T9.40),
// a closed suggestion's unsaved text, a peer's restore and an update never stack up as competing cards. One card
// leads (notice-stack.ts's precedence); what it hides stays reachable from it, and every payload stays in its own store
// until it is dismissed there, whatever the pane shows meanwhile.
import { BOTTOM_REGION_ATTR, NOTICE_BAND_ATTR } from '@moss-multi/protocol/dom-contract';
import { useState, type ReactNode } from 'react';
import { RestoreNoticeBand } from '../history/HistoryView.tsx';
import { arrangeNotices, NOTICE_ACTION, standAboveTrashNotice } from '../notice-stack.ts';
import { RefusalAnnouncer, useRefusalMessage } from '../surfaces/RefusalAnnouncer.tsx';
import { BOTTOM_REGION } from './bottom-row.ts';
import { NoticeCard, PendingCue, useNotice } from './ConnectionNotice.tsx';
import { useCue } from './connection.ts';
import { useRestoreNotice } from './restore-notice.ts';
import { useNoSuggestionRoom, useUnsaved } from './suggest/mode.ts';
import { UnsavedCard } from './suggest/UnsavedCard.tsx';

/** A lead's disclosure of a card it hides: pressed, the card shows just above it. */
function Disclose({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }): ReactNode {
  return <button type="button" aria-expanded={open} className={NOTICE_ACTION} onClick={onToggle}>{children}</button>;
}

/**
 * The notices of `docId`'s pane, top to bottom: a card the lead discloses, the lead, then the pending-write cue while
 * no connection notice stands in for it. With Moss's own Trash notice showing (`trashNotice`), that is the note's
 * terminal notice, and unsaved text leads above it.
 */
export function NoticeStack({ docId, trashNotice = false }: { docId: string; trashNotice?: boolean }): ReactNode {
  const notice = useNotice(docId);
  const cue = useCue(docId);
  const payloads = useUnsaved(docId);
  const noRoom = useNoSuggestionRoom(docId);
  const restore = useRestoreNotice(docId);
  // What the reader opened, for this note only: another note starts closed, and its payloads are all still there.
  const [opened, setOpened] = useState<{ docId: string; recover: boolean; restore: boolean }>({ docId, recover: false, restore: false });
  const open = opened.docId === docId ? opened : { docId, recover: false, restore: false };
  const toggle = (which: 'recover' | 'restore') => setOpened({ ...open, [which]: !open[which] });
  const outdated = notice?.terminal === 'outdated';
  const arranged = arrangeNotices({
    terminal: notice !== null && notice.terminal !== null && !outdated,
    unsaved: payloads.length > 0 || noRoom !== null,
    outage: notice !== null && notice.terminal === null,
    restore: restore !== null,
    update: outdated,
    trashNotice,
  });
  // Recovery is offered only for text this window really holds.
  const recover = arranged.recover && payloads.length > 0;
  const extra = recover || arranged.restoreDetails ? (
    <>
      {recover ? <Disclose open={open.recover} onToggle={() => toggle('recover')}>Recover unsaved text ({payloads.length})</Disclose> : null}
      {arranged.restoreDetails ? <Disclose open={open.restore} onToggle={() => toggle('restore')}>Restore details</Disclose> : null}
    </>
  ) : undefined;
  const lead = (() => {
    switch (arranged.lead) {
      case 'terminal':
      case 'outage':
      case 'update':
        return notice ? <NoticeCard docId={docId} notice={notice} extra={extra} /> : null;
      case 'unsaved':
        return <UnsavedCard docId={docId} extra={extra} />;
      case 'restore':
        return <RestoreNoticeBand docId={docId} />;
      default:
        return null;
    }
  })();
  return (
    <>
      {recover && open.recover ? <UnsavedCard docId={docId} /> : null}
      {arranged.restoreDetails && open.restore ? <RestoreNoticeBand docId={docId} /> : null}
      {lead}
      {notice === null && cue !== 'hidden' ? <PendingCue docId={docId} cue={cue} /> : null}
    </>
  );
}

/**
 * The pane's band under the top bar, in flow and zero-height, holding nothing visible. Where the pane has no bottom
 * region of its own (no note bound, or a note in Trash) it floats one at the bottom, above a Trash notice if one
 * shows: an ended session's notice with no note bound, the input refusals when `refusals` (T9.35), and the notices of
 * a note in Trash (`trashed`, its id) other than the Trash notice itself.
 */
export function NoticeBand({ docId, refusals = docId === null, trashed = null }: { docId: string | null; refusals?: boolean; trashed?: string | null }) {
  const notice = useNotice(docId);
  // A refusal showing re-renders this, so the region stands above a Trash notice that appeared since.
  useRefusalMessage();
  const floating = docId === null && notice;
  return <div {...{ [NOTICE_BAND_ATTR]: '' }} className="shrink-0">
    {floating || refusals || trashed ? (
      <div {...{ [BOTTOM_REGION_ATTR]: '' }} ref={(el) => standAboveTrashNotice(el)} className={BOTTOM_REGION}>
        {refusals ? <RefusalAnnouncer /> : null}
        {trashed ? <NoticeStack docId={trashed} trashNotice /> : null}
        {floating ? <NoticeCard docId={null} notice={notice} /> : null}
      </div>
    ) : null}
  </div>;
}
