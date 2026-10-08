// A push or an import runs the converter's import normalization on the pushed text (pipeline.ts $importNoteBody), and
// the mirror runs moss's formatted-whitespace callback on each formatted text node. moss's comment-marker regexes there
// were cubic in a run of blanks after a marker opener, and its trailing-blank regex quadratic in an inner run; their
// scans (comment-marker-scan.ts, golden-equal in converter/comment-markers.golden.test.ts) are linear up to the 2 MB
// push cap, through landPush and importBody.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MARKDOWN_CAP_BYTES } from '@moss-multi/protocol/limits';
import { landPush } from './push.ts';
import { exportDocMarkdown, importBody } from './server-doc.ts';

const NOTE = 'note-1';

/** Pushed text that the old patterns rescanned from every position. */
const ATTACKS: Record<string, (n: number) => string> = {
  // COMMENT_WRAPPED_ATX_HEADING_LINE and COMMENT_WRAPPED_IMAGE (and findMarkers on import): an opener, then blanks.
  'a marker opener and spaces': (n) => `%%m:${' '.repeat(n - 5)}!`,
  'a legacy opener and tabs': (n) => `{%c:${'\t'.repeat(n - 5)}!`,
  // COMMENT_WRAPPED_ATX_HEADING_LINE: a wrapped heading whose closers never end the line.
  'a wrapped heading of closers that do not end it': (n) => `%%m:a:start%%# h${'%%m: a :end%%x'.repeat(n / 15)}`,
  // COMMENT_WRAPPED_IMAGE: an opener, then image openers or an image source that never closes.
  'an opener and image openers': (n) => `%%m:a:start%%${'!['.repeat(n / 2)}`,
  'an opener and an unclosed source': (n) => `%%m:a:start%%![a](${'(x)'.repeat(n / 3)}`,
  // format-whitespace.ts's /[ \t]+$/ on a bold text node.
  'bold text around spaces': (n) => `**a${' '.repeat(n - 6)}b**`,
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

/** A push of `text` after a note's first paragraph; a refusal still ran the converter. */
function push(text: string): void {
  const live = new Y.Doc();
  importBody(live, 'Start.');
  const base = exportDocMarkdown(live, NOTE);
  try {
    landPush(live, NOTE, { base, newText: `${base.trimEnd()}\n\n${text}\n`, force: false }, 'test-push');
  } catch {
    // A refused push (409 push-unverified) has already converted the text.
  }
}

function importNote(text: string): void {
  importBody(new Y.Doc(), text, undefined, undefined, {});
}

describe('pushed and imported text runs the converter in linear time up to the 2 MB push cap @p:agt-1', () => {
  for (const [name, attack] of Object.entries(ATTACKS)) {
    it(`landPush: ${name}`, () => expectLinear(push, attack), 300_000);
  }
  it('importBody with a comments sidecar (findMarkers): a marker opener and spaces', () => {
    expectLinear(importNote, (n) => `x %%m:a:start%%y %%m:${' '.repeat(n - 24)}!`);
  }, 300_000);
});
