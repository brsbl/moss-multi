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

describe('T5.S16 a reply to a frame this window never sent settles nothing', () => {
  it('a refusal, an ack or a grant answering another request leaves the oldest one unacked', () => {
    const ledger = new SuggestLedger();
    ledger.sent(ops('a'));
    expect(ledger.replied({ t: 'suggest-refused', record: 'unknown-0', reason: 'record' })).toBeUndefined();
    expect(ledger.replied({ t: 'suggest-ack', record: 'z', requested: 'z', doc: 'body', sv: {}, parts: [] })).toBeUndefined();
    expect(ledger.replied({ t: 'suggest-leased', leases: [] })).toBeUndefined();
    expect(ledger.replied({ t: 'suggest-refused', record: null, reason: 'malformed' })).toBeUndefined();
    expect(ledger.unacked, 'a is still in flight').toBe(true);
    expect(ledger.replied({ t: 'suggest-ack', record: 'a2', requested: 'a', doc: 'body', sv: {}, parts: [] })).toEqual(ops('a'));
    expect(ledger.unacked).toBe(false);
    const lease: SuggestRequest = { t: 'suggest-lease', fork: 'fork-0001' };
    ledger.sent(lease);
    expect(ledger.replied({ t: 'suggest-refused', record: null, reason: 'lease-cap' }), 'a lease is refused naming no record').toEqual(lease);
  });
});
