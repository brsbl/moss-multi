// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { OUTDATED_ERROR } from '@moss-multi/protocol/client-protocol';
import { askDocAccess, knownRole, rememberRole, startRoleRead, supersedeRoleReads } from './access.ts';
import { clientOutdated } from './client-protocol.ts';

const answering = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('the access check and an outdated bundle (registers.md rule 10)', () => {
  it('a 503, or a 426 that is not client-outdated, is transient; a client-outdated 426 marks the tab outdated', async () => {
    expect(await askDocAccess('d1', answering(503, { error: 'unavailable' }))).toEqual({ kind: 'unavailable' });
    expect(await askDocAccess('d2', answering(426, { error: 'other' }))).toEqual({ kind: 'unavailable' });
    expect(clientOutdated(), 'neither is an update').toBe(false);
    expect(await askDocAccess('d3', answering(426, { error: OUTDATED_ERROR }))).toEqual({ kind: 'outdated' });
    expect(clientOutdated(), 'the tab stays outdated').toBe(true);
  });
});

describe('role reads in order (T9.12)', () => {
  it('a read started before a newer one answered never undoes it', () => {
    const raised = startRoleRead();
    const lowered = startRoleRead();
    expect(lowered('order-1', 'viewer')).toBe(true);
    expect(raised('order-1', 'editor'), 'the older answer is dropped').toBe(false);
    expect(knownRole('order-1')).toBe('viewer');
  });

  it('a read started before access changed is superseded; one started after applies', () => {
    rememberRole('order-2', 'viewer');
    const before = startRoleRead();
    supersedeRoleReads('order-2');
    const after = startRoleRead();
    expect(before('order-2', 'editor'), 'the read from before the change is dropped').toBe(false);
    expect(knownRole('order-2')).toBe('viewer');
    expect(after('order-2', 'editor')).toBe(true);
    expect(knownRole('order-2')).toBe('editor');
  });
});
