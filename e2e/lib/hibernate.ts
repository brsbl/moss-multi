// Eviction levers and the proof of induction (S-test §3.7). A hibernation leg is valid only when the DO that
// served the decisive action is a new instance; otherwise it fails as "not induced", never passes vacuously.
import { readFileSync } from 'node:fs';
import { signIn, type Principal } from './principals.ts';
import type { Stack } from './stack.ts';

export interface Instance { instanceId: string; constructedAt: number }

/** Measured in real workerd by the calibration project; nightly fails when the committed window is too short. */
const calibration = JSON.parse(readFileSync(new URL('./calibrated.json', import.meta.url), 'utf8')) as { idleMs: number };
export const IDLE_MS = calibration.idleMs;
/** The runner's and workerd's clocks are one host's, read at different moments. */
const CLOCK_SKEW_MS = 250;

/**
 * Problems with a claimed wake: the instance must change, and be constructed after the baseline, by the action: no
 * earlier than its start and no later than its end (`decisiveEnd`, else 2 s after the start). A WebKit page's first
 * load after a stack restart can take 10 s before its first request reaches the doc.
 */
export function inductionProblems(base: Instance, after: Instance, decisiveAt: number, decisiveEnd = decisiveAt + 2_000, skewMs = CLOCK_SKEW_MS): string[] {
  const problems: string[] = [];
  if (after.instanceId === base.instanceId) problems.push(`instance ${base.instanceId} still serves the doc`);
  if (!(after.constructedAt > base.constructedAt)) {
    problems.push(`instance constructed at ${after.constructedAt}, not after the baseline's ${base.constructedAt}`);
  }
  if (after.constructedAt < decisiveAt - skewMs) {
    problems.push(`instance constructed ${decisiveAt - after.constructedAt} ms before the decisive action, so something else woke it`);
  }
  if (after.constructedAt > decisiveEnd + skewMs) {
    problems.push(`instance constructed ${after.constructedAt - decisiveEnd} ms after the decisive action ended, so something else woke it`);
  }
  return problems;
}

export interface InduceOptions {
  docId: string;
  /** Closes, backgrounds or freezes every client of the doc. */
  quiesce: () => Promise<void>;
  /** The lever: natural idle (default), a stack restart (L1) or one DO reset (L2). */
  lever?: 'idle' | 'restart' | 'reset';
  idleMs?: number;
  /** Reopen, a peer joining, or a surviving socket's first frame. */
  decisive: () => Promise<void>;
  /** Reads the doc's DO instance; defaults to the loopback hook. Staging has no hooks: see ownerProbe. */
  probe?: (docId: string) => Promise<Instance>;
  /** The allowed clock difference between the runner and the Worker (another host's clock on staging). */
  skewMs?: number;
}

/**
 * The owner-only `GET /api/docs/:id/instance` (A§19), which answers the same probe in every environment, so a wake
 * is proven on real Cloudflare (SP14). It reads nothing from the doc and never wakes it.
 */
export function ownerProbe(stack: Stack, owner: Principal): (docId: string) => Promise<Instance> {
  return async (docId) => {
    const cookie = (await signIn(stack.baseUrl, owner)).map(({ name, value }) => `${name}=${value}`).join('; ');
    const url = `${stack.baseUrl}/api/docs/${encodeURIComponent(docId)}/instance`;
    const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`owner instance probe for ${docId}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return (await response.json()) as Instance;
  };
}

/**
 * Baseline, quiesce, evict, act, then probe. Nothing probes between the idle and the decisive action, because
 * the probe itself would wake the DO.
 */
export async function induce(stack: Stack, options: InduceOptions): Promise<{ base: Instance; after: Instance }> {
  const probe = options.probe ?? ((docId: string) => stack.docInstance(docId));
  const base = await probe(options.docId);
  await options.quiesce();
  const lever = options.lever ?? 'idle';
  if (lever === 'restart') await stack.restart();
  else if (lever === 'reset') await stack.resetDoc(options.docId);
  else await new Promise((done) => setTimeout(done, options.idleMs ?? IDLE_MS));
  const decisiveAt = Date.now();
  await options.decisive();
  const decisiveEnd = Date.now();
  const after = await probe(options.docId);
  const problems = inductionProblems(base, after, decisiveAt, decisiveEnd, options.skewMs);
  if (problems.length > 0) throw new Error(`hibernation not induced (${lever}): ${problems.join('; ')}`);
  return { base, after };
}
