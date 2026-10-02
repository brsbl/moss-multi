// Eviction levers and the proof of induction (S-test §3.7). A hibernation leg is valid only when the DO that
// served the decisive action is a new instance; otherwise it fails as "not induced", never passes vacuously.
import type { Stack } from './stack.ts';

export interface Instance { instanceId: string; constructedAt: number }

/** Idle time for the natural lever (L3); calibration replaces it with max(95 s, 1.2 x measured). */
export const IDLE_MS = 95_000;

/** Problems with a claimed wake: the instance must change, and be constructed after the baseline, by the action. */
export function inductionProblems(base: Instance, after: Instance, decisiveAt: number): string[] {
  const problems: string[] = [];
  if (after.instanceId === base.instanceId) problems.push(`instance ${base.instanceId} still serves the doc`);
  if (!(after.constructedAt > base.constructedAt)) {
    problems.push(`instance constructed at ${after.constructedAt}, not after the baseline's ${base.constructedAt}`);
  }
  if (after.constructedAt > decisiveAt + 2_000) {
    problems.push(`instance constructed ${after.constructedAt - decisiveAt} ms after the decisive action, so something else woke it`);
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
}

/**
 * Baseline, quiesce, evict, act, then probe. Nothing probes between the idle and the decisive action, because
 * the probe itself would wake the DO.
 */
export async function induce(stack: Stack, options: InduceOptions): Promise<{ base: Instance; after: Instance }> {
  const base = await stack.docInstance(options.docId);
  await options.quiesce();
  const lever = options.lever ?? 'idle';
  if (lever === 'restart') await stack.restart();
  else if (lever === 'reset') await stack.resetDoc(options.docId);
  else await new Promise((done) => setTimeout(done, options.idleMs ?? IDLE_MS));
  const decisiveAt = Date.now();
  await options.decisive();
  const after = await stack.docInstance(options.docId);
  const problems = inductionProblems(base, after, decisiveAt);
  if (problems.length > 0) throw new Error(`hibernation not induced (${lever}): ${problems.join('; ')}`);
  return { base, after };
}
