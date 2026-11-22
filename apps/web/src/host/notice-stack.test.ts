import { describe, expect, it } from 'vitest';
import { arrangeNotices, type NoticeInputs } from './notice-stack.ts';

const none: NoticeInputs = { terminal: false, unsaved: false, outage: false, restore: false, update: false, trashNotice: false };
const arrange = (input: Partial<NoticeInputs>) => arrangeNotices({ ...none, ...input });

describe('T9.41 one notice leads the pane\'s bottom region, in precedence order', () => {
  it('shows nothing when nothing needs saying', () => {
    expect(arrange({})).toEqual({ lead: null, recover: false, restoreDetails: false });
  });

  it('leads with a terminal close, then unsaved work, an outage, a peer restore and an update', () => {
    const all = { terminal: true, unsaved: true, outage: true, restore: true, update: true };
    expect(arrange(all).lead).toBe('terminal');
    expect(arrange({ ...all, terminal: false }).lead).toBe('unsaved');
    expect(arrange({ ...all, terminal: false, unsaved: false }).lead).toBe('outage');
    expect(arrange({ restore: true, update: true }).lead).toBe('restore');
    expect(arrange({ update: true }).lead).toBe('update');
  });

  it('a terminal notice carries Recover unsaved text whenever text is held; no other lead does', () => {
    expect(arrange({ terminal: true, unsaved: true }).recover).toBe(true);
    expect(arrange({ terminal: true }).recover).toBe(false);
    expect(arrange({ unsaved: true, outage: true })).toMatchObject({ lead: 'unsaved', recover: false });
  });

  it('a peer restore behind a higher notice stays reachable from it as Restore details', () => {
    expect(arrange({ terminal: true, restore: true }).restoreDetails).toBe(true);
    expect(arrange({ unsaved: true, restore: true }).restoreDetails).toBe(true);
    expect(arrange({ outage: true, restore: true }).restoreDetails).toBe(true);
    expect(arrange({ restore: true }).restoreDetails).toBe(false);
  });

  it('with Moss\'s own Trash notice showing, unsaved work leads above it instead of a second terminal card', () => {
    expect(arrange({ trashNotice: true, terminal: true, unsaved: true })).toEqual({ lead: 'unsaved', recover: false, restoreDetails: false });
    expect(arrange({ trashNotice: true, terminal: true }).lead).toBe(null);
  });
});
