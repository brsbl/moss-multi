// Each scan that replaced a comment-marker regex on the converter's import path, and moss's formatted-whitespace
// callback, is linear in attacker text up to the 2 MB push cap. ../push-markers.linear.test.ts runs the shapes whose
// whole push path is linear here; these shapes (long lines of images or blanks) are linear end to end only with the
// converter's linear import and export (T3.S4), so they are held at the function a push calls.
import { createHeadlessEditor } from '@lexical/headless';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { describe, expect, it } from 'vitest';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { normalizeCommentWrappedAtxHeadings, normalizeCommentWrappedImages } from '@moss-desktop/renderer/editor/utils/comment-import';
import { scanCommentMarkers } from '@moss-desktop/renderer/editor/utils/comment-marker-scan';

// The push cap, MARKDOWN_CAP_BYTES in @moss-multi/protocol/limits.
const MARKDOWN_CAP_BYTES = 2 * 1024 * 1024;

function expectLinear(run: (text: string) => unknown, attack: (n: number) => string): void {
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
    expect(took, `${n} chars took ${Math.round(took)} ms after ${Math.round(previous)} ms for half`).toBeLessThan(3 * previous + 50);
    previous = took;
  }
}

/** moss's callback on one bold text node, as the server mirror runs it on a pushed `**text**`. */
function normalizeBold(text: string): void {
  const editor = createHeadlessEditor({ onError: (error) => { throw error; } });
  editor.update(() => {
    const paragraph = $createParagraphNode();
    const node = $createTextNode(text).setFormat('bold');
    $getRoot().append(paragraph.append(node));
    $normalizeFormatWhitespace(node);
  }, { discrete: true });
}

const SHAPES: [string, (text: string) => unknown, (n: number) => string][] = [
  ['COMMENT_WRAPPED_ATX_HEADING_LINE: an opener and spaces', normalizeCommentWrappedAtxHeadings, (n) => `%%m:${' '.repeat(n - 5)}!`],
  ['COMMENT_WRAPPED_ATX_HEADING_LINE: an opener and tabs', normalizeCommentWrappedAtxHeadings, (n) => `{%c:${'\t'.repeat(n - 5)}!`],
  ['COMMENT_WRAPPED_IMAGE: an opener and spaces', normalizeCommentWrappedImages, (n) => `%%m:${' '.repeat(n - 5)}!`],
  ['COMMENT_WRAPPED_IMAGE: an opener and image openers', normalizeCommentWrappedImages, (n) => `%%m:a:start%%${'!['.repeat(n / 2)}`],
  ['COMMENT_WRAPPED_IMAGE: images no closer ends', normalizeCommentWrappedImages, (n) => `%%m:a:start%%${'![a](b)c'.repeat(n / 8)}`],
  ['COMMENT_WRAPPED_IMAGE: an unclosed source', normalizeCommentWrappedImages, (n) => `%%m:a:start%%![a](${'(x)'.repeat(n / 3)}`],
  ['COMMENT_WRAPPED_IMAGE: image openers sharing one source', normalizeCommentWrappedImages, (n) => `%%m:a:start%%${'!['.repeat(n / 4)}](${'x'.repeat(n / 2)}`],
  ['findMarkers: an opener and spaces', scanCommentMarkers, (n) => `%%m:${' '.repeat(n - 5)}!`],
  ['format-whitespace: bold text around spaces', normalizeBold, (n) => `a${' '.repeat(n - 2)}b`],
];

describe('comment-marker scans and the formatted-whitespace callback are linear up to the 2 MB push cap @p:agt-1', () => {
  for (const [name, run, attack] of SHAPES) {
    it(name, () => expectLinear(run, attack), 300_000);
  }
});
