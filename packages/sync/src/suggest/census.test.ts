// T5.0 spike, tests 2 and 3 (docs/design/suggestions.md §9): every census operation, made by a real moss editor on
// the fork F, is recorded with no refusal, and accepting the record equals an editor making the same edit directly,
// payload docs included (T5.P: code, HTML, formula, chart and sketch payloads are their own docs).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { SuggestIngest } from '../doc/suggest.ts';
import { payloadDocsFor } from '../payload-docs.ts';
import { ForkShim } from './fork-shim.ts';
import { acceptRecord, nodeRegistry, previewRecord } from './review.ts';
import {
  CENSUS, deterministicIds, directEdit, EDITOR, exported, payloadsInOrder, resetIds, seededBody, SUGGESTER, type Step,
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

describe('T5.P payload ops are recorded per payload doc @p:mean-2', () => {
  it.each([
    ['new code block', 'new code'],
    ['new HTML block', '<b>new</b>'],
    ['new formula', '3*3'],
    ['an edit of an original code payload', 'seed!'],
  ])('%s: its payload text travels as an op on its own payload doc, under the lease', (name, text) => {
    const { steps } = CENSUS.find((op) => op.name === name)!;
    const { live, fork, results } = suggest(steps);
    try {
      const payloadOps = fork.sent.filter((op) => op.doc !== 'body');
      expect(payloadOps.length, 'a payload op is sent').toBeGreaterThan(0);
      expect(new Set(payloadOps.map((op) => op.doc)).size, 'one payload doc').toBe(1);
      // The body's payload as it was (none for a new block), then the record's ops on it.
      const written = new Y.Doc();
      const base = payloadDocsFor(live).get(payloadOps[0].doc);
      if (base) Y.applyUpdate(written, Y.encodeStateAsUpdate(base));
      for (const op of payloadOps) Y.applyUpdate(written, op.update);
      expect(written.getText('payload').toString()).toContain(text);
      expect(base?.getText('payload').toString() ?? '', 'the body keeps its payload until accept').not.toContain(text);
      for (const op of payloadOps) expect([...Y.parseUpdateMeta(op.update).from.keys()]).toEqual([fork.fork.clientID]);
      expect(results.every((result) => result.ok)).toBe(true);
    } finally {
      fork.dispose();
    }
  });
});

describe('T5.0 accept equals the direct edit @p:mean-2 @p:R17', () => {
  it.each(CENSUS)('$name', ({ steps }) => {
    const { live, fork } = suggest(steps);
    try {
      const preview = previewRecord(live, 'r1');
      if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
      expect(acceptRecord(live, 'r1', { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
      resetIds();
      const oracle = directEdit(seededBody(), steps);
      // A record that changes nothing visible (a split and its undo) shows no hunk; everything else shows one.
      if (exported(oracle) !== exported(seededBody())) expect(preview.hunks.length, 'the reviewer is shown the change').toBeGreaterThan(0);
      expect(exported(live)).toBe(exported(oracle));
      expect(payloadsInOrder(live)).toEqual(payloadsInOrder(oracle));
    } finally {
      fork.dispose();
    }
  });
});
