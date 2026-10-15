import { describe, expect, it } from 'vitest';
import { closeAction } from '@moss-multi/protocol/sync';
import { connectionOf, reduceLink, startLink } from './connection.ts';

describe('connection truth', () => {
  it('keeps a silence verdict through reconnect attempts until sync delivers', () => {
    let link = reduceLink(startLink(0), { type: 'synced' });
    expect(connectionOf(link, 20_000)).toBe('online');
    link = reduceLink(link, { type: 'silent', lastHeard: 20_000 });
    link = reduceLink(link, { type: 'closed', at: 33_000 });
    expect(connectionOf(link, 33_000)).toBe('offline');
    expect(connectionOf(reduceLink(link, { type: 'synced' }), 34_000)).toBe('online');
  });
  it.each([1001, 1006, 1011, 1012, 1013, 4408, 4420])('keeps buffered edits on transient close %s', (code) => {
    expect(closeAction(code)).toEqual({ kind: 'retry' });
  });
  it.each([[4401, 'session-ended'], [4402, 'session-ended'], [4404, 'unavailable'], [4410, 'deleted'], [4426, 'outdated'], [4429, 'conn-limit']] as const)(
    'stops designed refusal %s', (code, reason) => expect(closeAction(code)).toEqual({ kind: 'terminal', reason }),
  );
  it('rechecks a changed grant and rebinds a refused write', () => {
    expect(closeAction(4403)).toEqual({ kind: 'reask' });
    expect(closeAction(4409)).toEqual({ kind: 'refused' });
    expect(closeAction(1000)).toEqual({ kind: 'normal' });
  });
});
