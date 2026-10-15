import { describe, expect, it } from 'vitest';
import type { SuggestRequest } from '@moss-multi/protocol/suggest';
import { SuggestLedger } from './suggest-acks.ts';

const ops = (record: string): SuggestRequest => ({ t: 'suggest-ops', record, update: 'AA==' });

describe('T5.2 suggest acks drive data-sync-unacked @p:tech-7', () => {
  it('stays unacked until every request has its reply, in order', () => {
    const ledger = new SuggestLedger();
    expect(ledger.unacked).toBe(false);
    ledger.sent(ops('a'));
    ledger.sent(ops('b'));
    expect(ledger.unacked).toBe(true);
    expect(ledger.replied()).toEqual(ops('a'));
    expect(ledger.unacked).toBe(true);
    expect(ledger.replied()).toEqual(ops('b'));
    expect(ledger.unacked).toBe(false);
  });

  it('a request in flight when the socket drops stays unacked until the fork takes it to resend', () => {
    const ledger = new SuggestLedger();
    ledger.sent(ops('a'));
    ledger.dropped();
    ledger.held(ops('b'));
    expect(ledger.unacked).toBe(true);
    expect(ledger.takeUnsent()).toEqual([ops('a'), ops('b')]);
    expect(ledger.unacked).toBe(false);
  });
});
