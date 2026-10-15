// A push or an import runs the converter's import normalization on the pushed text (pipeline.ts $importNoteBody), and
// an import with a comments sidecar runs moss's findMarkers on each text node. moss's comment-marker regexes there were
// cubic in a run of blanks (any `\s`, newlines included) after a marker opener; their scans (comment-marker-scan.ts,
// golden-equal in converter/comment-markers.golden.test.ts) are linear up to the 2 MB push cap through landPush and
// importBody. converter/comment-markers.linear.test.ts holds each scan, and moss's formatted-whitespace callback, to
// linear time at the function; with the converter's linear import (T3.S4) the long single-line shapes hold here too,
// on an ordinary push and a --suggest (fork) push alike.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MARKDOWN_CAP_BYTES } from '@moss-multi/protocol/limits';
import { landPush } from './push.ts';
import { ReconcileRefused, type ForkTarget } from './reconcile.ts';
import { exportDocMarkdown, importBody } from './server-doc.ts';

const NOTE = 'note-1';

/** Pushed text that the old patterns rescanned from every position. */
const ATTACKS: Record<string, (n: number) => string> = {
  // COMMENT_WRAPPED_ATX_HEADING_LINE and COMMENT_WRAPPED_IMAGE: an opener, then blanks.
  'a marker opener and blank lines': (n) => `%%m:${'\n'.repeat(n - 5)}!`,
  'a legacy marker opener and blank lines': (n) => `{%c:${'\n'.repeat(n - 5)}!`,
  // The long single-line legs T7.S1 deferred to T3.S4's linear import (T7.R).
  'a marker opener and spaces on one line': (n) => `%%m:${' '.repeat(n - 5)}!`,
  'a legacy marker opener and tabs on one line': (n) => `{%c:${'\t'.repeat(n - 5)}!`,
  // COMMENT_WRAPPED_IMAGE's image candidates.
  'a run of images after a marker': (n) => `%%m:a:start%%${'![a](b)c'.repeat(n / 8)}`,
  'image openers after a marker': (n) => `%%m:a:start%%${'!['.repeat(n / 2)}`,
  'an unclosed image source after a marker': (n) => `%%m:a:start%%![a](${'(x)'.repeat(n / 3)}`,
  // moss's formatted-whitespace callback.
  'bold text around spaces': (n) => `**a${' '.repeat(n - 6)}b**`,
  'italic text around spaces': (n) => `*a${' '.repeat(n - 4)}b*`,
};

function expectLinear(run: (text: string) => void, attack: (n: number) => string): void {
  const time = (n: number): number => {
    const text = attack(n);
    const start = performance.now();
    run(text);
    return performance.now() - start;
  };
  time(1024); // warm up
  let previous = time(2048);
  for (let n = 4096; n <= MARKDOWN_CAP_BYTES; n *= 2) {
    const took = time(n);
    expect(took, `${n} chars took ${Math.round(took)} ms after ${Math.round(previous)} ms for half`).toBeLessThan(3 * previous + 250);
    previous = took;
  }
}

type Land = typeof landPush;

/**
 * A push of `text` after a note's first paragraph, through `land`. It must reach the converter: it lands a change, or
 * the reconcile refuses it unverified (409) after converting. Anything else (an error, a degenerate or properties
 * refusal, an over-budget refusal before conversion, a push that changed nothing) fails. With `fork` (--suggest) the
 * live doc stays as it was.
 */
function pushWith(land: Land, text: string, fork?: ForkTarget): void {
  const live = new Y.Doc();
  importBody(live, 'Start.');
  const base = exportDocMarkdown(live, NOTE);
  const before = Y.encodeStateVector(live);
  let outcome: ReturnType<Land>;
  try {
    outcome = land(live, NOTE, { base, newText: `${base.trimEnd()}\n\n${text}\n`, force: false, ...(fork ? { fork } : {}) }, 'test-push');
  } catch (error) {
    // Refused unverified after the reconcile converted the text; an over-budget refusal comes before converting.
    if (!(error instanceof ReconcileRefused) || error.reason !== 'unverified' || /too many places/.test(error.message)) throw error;
    if (fork) expect(Y.encodeStateVector(live), 'a refused suggestion leaves the note as it was').toEqual(before);
    return;
  }
  expect(outcome, 'the push reached the converter and changed the note').toMatchObject({ ok: true, changed: true });
  if (fork) {
    expect(fork.ops.length, 'the suggestion collected its ops').toBeGreaterThan(0);
    expect(Y.encodeStateVector(live), 'a suggestion leaves the note as it was').toEqual(before);
  }
}

const push = (text: string): void => pushWith(landPush, text);
const suggest = (text: string): void => pushWith(landPush, text, { client: 434343, ops: [] });

function importNote(text: string): void {
  importBody(new Y.Doc(), text, undefined, undefined, {});
}

describe('pushed and imported text runs the converter in linear time up to the 2 MB push cap @p:agt-1', () => {
  for (const [name, attack] of Object.entries(ATTACKS)) {
    it(`landPush: ${name}`, () => expectLinear(push, attack), 300_000);
    it(`landPush --suggest: ${name}`, () => expectLinear(suggest, attack), 300_000);
  }
  it('importBody with a comments sidecar (findMarkers): a marker opener and form feeds', () => {
    expectLinear(importNote, (n) => `x %%m:a:start%%y %%m:${'\f'.repeat(n - 24)}!`);
  }, 300_000);
});

describe('the push helper counts only a push that reached the converter (B342)', () => {
  it('fails a push that throws, refuses before converting or changes nothing, and passes a real one', () => {
    expect(() => pushWith(() => { throw new Error('boom'); }, 'More.')).toThrow('boom');
    expect(() => pushWith(() => ({ ok: false, reason: 'degenerate', deletedRatio: 1 }), 'More.')).toThrow();
    expect(() => pushWith(() => ({ ok: false, reason: 'properties' }), 'More.', { client: 1, ops: [] })).toThrow();
    expect(() => pushWith(() => ({ ok: true, applied: 0, failedHunks: [], changed: false }), 'More.')).toThrow();
    expect(() => pushWith(() => { throw new ReconcileRefused('unverified', 'the push changes too many places'); }, 'More.')).toThrow();
    expect(() => pushWith(() => { throw new ReconcileRefused('mismatch', 'no'); }, 'More.')).toThrow();
    expect(() => push('More.')).not.toThrow();
    expect(() => suggest('More.')).not.toThrow();
    expect(() => push('Some _emphasis_ text.'), 'an unverified refusal after converting counts').not.toThrow();
  });
});
