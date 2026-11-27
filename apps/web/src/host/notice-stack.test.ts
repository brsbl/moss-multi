import { describe, expect, it } from 'vitest';
import { arrangeNotices, classifyConnectionNotice, type NoticeInputs } from './notice-stack.ts';

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

describe('T9.56 the connection notice\'s class', () => {
  const classed = (kind: string, terminal: string | null) => classifyConnectionNotice({ kind, terminal });

  it('ranks a Suggest window refused its lease with the notices that close the note until the person acts', () => {
    expect(classed('suggest-busy', null)).toEqual({ terminal: true, outage: false, update: false });
    // It holds kept text: the refusal and its Retry lead, and the text is one press away on it.
    expect(arrange({ ...classed('suggest-busy', null), unsaved: true })).toEqual({ lead: 'terminal', recover: true, restoreDetails: false });
  });

  it('keeps every other notice where it was', () => {
    expect(classifyConnectionNotice(null)).toEqual({ terminal: false, outage: false, update: false });
    expect(classed('offline', null)).toEqual({ terminal: false, outage: true, update: false });
    expect(classed('retrying', null)).toEqual({ terminal: false, outage: true, update: false });
    expect(classed('conn-limit', 'conn-limit')).toEqual({ terminal: true, outage: false, update: false });
    expect(classed('outdated', 'outdated')).toEqual({ terminal: false, outage: false, update: true });
    expect(arrange({ ...classed('offline', null), unsaved: true }).lead, 'the card still leads over a lost connection').toBe('unsaved');
  });
});
