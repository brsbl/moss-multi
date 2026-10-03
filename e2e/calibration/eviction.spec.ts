// SP4: probe each idle doc once, never poll the same doc and accidentally reset its idle clock.
import { writeFile } from 'node:fs/promises';
import { holdDocSockets, cookieHeader } from '../lib/doc-client.ts';
import { IDLE_MS } from '../lib/hibernate.ts';
import { signIn } from '../lib/principals.ts';
import { expect, test } from '../lib/test.ts';

const BUCKETS = [30_000, 60_000, 90_000, 120_000, 150_000];
test('calibration: bucket real workerd eviction and record reset socket survival @slow', async ({ actors, stack }, info) => {
  test.setTimeout(210_000);
  actors.solo('calibration probes storage lifecycle, not collaboration');
  const owner = await actors.principal('calibration');
  const cookie = cookieHeader(await signIn(stack.baseUrl, owner));
  const create = async () => {
    const response = await fetch(`${stack.baseUrl}/api/docs`, {
      method: 'POST', headers: { cookie, origin: stack.baseUrl, 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { doc: { id: string } }).doc.id;
  };
  const docs = await Promise.all(BUCKETS.map(async (idleMs) => {
    const docId = await create();
    const sockets = await holdDocSockets(stack.baseUrl, docId, cookie, 1);
    const base = await stack.docInstance(docId);
    return { idleMs, docId, sockets, base, startedAt: Date.now() };
  }));
  try {
    const samples = [];
    for (const doc of docs) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, doc.startedAt + doc.idleMs - Date.now())));
      const after = await stack.docInstance(doc.docId);
      samples.push({ idleMs: doc.idleMs, base: doc.base, after, evicted: after.instanceId !== doc.base.instanceId, survivingSockets: doc.sockets.open() });
    }
    const measuredMs = samples.find((sample) => sample.evicted)?.idleMs ?? null;
    const resetDoc = await create();
    const resetSockets = await holdDocSockets(stack.baseUrl, resetDoc, cookie, 1);
    let resetSocketsSurvive: boolean;
    try {
      const before = await stack.docInstance(resetDoc);
      await stack.resetDoc(resetDoc);
      expect((await stack.docInstance(resetDoc)).instanceId).not.toBe(before.instanceId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      resetSocketsSurvive = resetSockets.open() === 1;
    } finally { await resetSockets.close(); }
    const result = { measuredMs, idleMs: measuredMs === null ? null : Math.max(95_000, Math.ceil(measuredMs * 1.2)), resetSocketsSurvive, samples, provenance: stack.state.expected };
    const path = info.outputPath('calibrated.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('calibrated.json', { path, contentType: 'application/json' });
    expect(measuredMs, 'workerd eviction exceeds 150 s; recalibration needs investigation').not.toBeNull();
    if (measuredMs !== null) {
      expect(samples.filter((sample) => sample.idleMs >= measuredMs).every((sample) => sample.evicted), 'later buckets confirm eviction').toBe(true);
      expect(IDLE_MS, 'committed idle window needs recalibration').toBeGreaterThanOrEqual(result.idleMs!);
    }
    expect(samples.filter((sample) => sample.evicted).every((sample) => sample.survivingSockets === 1), 'natural hibernation preserves sockets').toBe(true);
  } finally { await Promise.all(docs.map((doc) => doc.sockets.close())); }
});
