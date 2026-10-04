// T5.0 spike, tests 2 and 3 (docs/design/suggestions.md §9): every census operation, made by a real moss editor on
// the fork F, is recorded with no refusal, and accepting the record equals an editor making the same edit directly.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { SuggestIngest } from '../doc/suggest.ts';
import { ForkShim } from './fork-shim.ts';
import { acceptRecord, nodeRegistry, previewRecord } from './review.ts';
import {
  CENSUS, deterministicIds, directEdit, EDITOR, exported, registersInOrder, resetIds, seededBody, SUGGESTER, type Step,
} from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

/** The suggester's fork makes `steps`; every forwarded frame goes through ingest as `suggest-ops`. */
function suggest(steps: readonly Step[]) {
  const live = seededBody();
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
  const [lease] = ingest.lease(SUGGESTER.id);
  resetIds();
  const fork = new ForkShim(live, lease);
  const atBind = fork.sent.length;
  for (const step of steps) {
    if (step === 'undo') fork.undo();
    else fork.act(step);
  }
  const results = fork.sent.map((update) => ingest.ops(SUGGESTER, 'suggester', 'r1', update));
  return { live, fork, atBind, results, frames: fork.sent.length };
}

describe('T5.0 census through a real moss editor on the fork @p:mean-2', () => {
  it.each(CENSUS)('$name: nothing is sent on bind, and every frame is recorded', ({ steps }) => {
    const { fork, atBind, results, frames } = suggest(steps);
    try {
      expect(atBind, 'binding F and filling it sends nothing').toBe(0);
      expect(frames, 'the operation reaches the wire').toBeGreaterThan(0);
      for (const result of results) expect(result).toMatchObject({ ok: true, record: 'r1' });
    } finally {
      fork.dispose();
    }
  });
});

describe('T5.0 accept equals the direct edit @p:mean-2', () => {
  it.each(CENSUS)('$name', ({ steps }) => {
    const { live, fork } = suggest(steps);
    try {
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
      expect(preview.hunks.length, 'the reviewer is shown the change').toBeGreaterThan(0);
      expect(acceptRecord(live, 'r1', { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
      resetIds();
      const oracle = directEdit(seededBody(), steps);
      expect(exported(live)).toBe(exported(oracle));
      expect(registersInOrder(live)).toEqual(registersInOrder(oracle));
    } finally {
      fork.dispose();
    }
  });
});
