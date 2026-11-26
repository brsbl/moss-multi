// T5.S16: a Suggest window refused its first lease because the person's other windows hold every one rebuilds
// nothing, so it is refused once, not again at once on a new socket; every other refusal keeps its path.
import { describe, expect, it } from 'vitest';
import { afterRefusal } from './rebuild.ts';

describe('T5.S16 what a Suggest pane does after a refusal @p:mean-2', () => {
  it('a lease-cap on a first lease remounts nothing: the note shows read-only until the person asks again', () => {
    expect(afterRefusal('lease-cap', { noRoom: false, ready: false })).toEqual({ rebuild: false, noRoom: false, busy: true });
  });

  it('other refusals keep their path: a closed record rebuilds, a note with no room stops after one rebuild', () => {
    expect(afterRefusal('record-closed', { noRoom: false, ready: true })).toMatchObject({ rebuild: true, noRoom: false });
    expect(afterRefusal('doc-cap', { noRoom: false, ready: true })).toMatchObject({ rebuild: true, noRoom: true });
    expect(afterRefusal('doc-cap', { noRoom: false, ready: false })).toMatchObject({ rebuild: false, noRoom: true });
    expect(afterRefusal('ops-cap', { noRoom: true, ready: true })).toMatchObject({ rebuild: false, noRoom: true });
    expect(afterRefusal('lease', { noRoom: false, ready: true })).toMatchObject({ rebuild: true, noRoom: false });
  });
});
