// The scans that replaced moss's comment-marker regexes on the converter's import path (comment-import.ts) and the
// formatted-whitespace callback's trailing-blank regex: golden-equal to moss's code (comment-markers.ref.ts) over the
// fixtures and fuzz strings. Their cost on attacker text is in ../push-markers.linear.test.ts.
import { createHeadlessEditor } from '@lexical/headless';
import fc from 'fast-check';
import { $createParagraphNode, $createTextNode, $getRoot, $isTextNode, type TextNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { normalizeCommentWrappedAtxHeadings, normalizeCommentWrappedImages } from '@moss-desktop/renderer/editor/utils/comment-import';
import { commentMarkerIdList, replaceCommentWrappedImages, scanCommentMarkers } from '@moss-desktop/renderer/editor/utils/comment-marker-scan';
import * as moss from './comment-markers.ref.ts';
import { FIXTURES } from './fixtures.ts';

const CASES = [
  '',
  '%%m:c1:start%%### Heading%%m:c1:end%%',
  '{%c:c1%}### Heading{%/c%}',
  '   %%m: c1 , c2 :start%%## H %%m:c1:end%%  \nnext',
  '    %%m:c1:start%%# four spaces%%m:c1:end%%',
  '%%m:c1:start%%####### seven%%m:c1:end%%\n%%m:c1:start%%#no space%%m:c1:end%%',
  '%%m:c1:start%%# a %%m:c1:end%% b %%m:c1:end%%\t\r\n%%m:c2:start%%# c{%/c%}',
  '%%m:\n a \n:start%%# h%%m:a:end%%',
  'x\r%%m:a:start%%# h%%m:a:end%%\u2028y\u2029%%m:  :start%%# z%%m: :end%%',
  '%%m:c1:start%%![alt](src)%%m:c1:end%%',
  '%%m:c1:start%%hello ![a](p.png) trailing%%m:c1:end%%',
  '%%m:c1:start%%![a](1.png)%%m:c2:start%%text%%m:c2:end%%',
  '%%m:c1:start%%![a](dir/img (1).png) caption (v2)%%m:c1:end%%',
  '{%c:c1%}![[ref.png]]{%/c%}',
  '%%m:c1:start%%![a](1.png) ![b](2.png)%%m:c1:end%%',
  '%%m:c1:start%%![a](1.png)%%m:c2:end%% after',
  '```\n%%m:c1:start%%![a](b)%%m:c1:end%%\n```\n%%m:c1:start%%![a](b)%%m:c1:end%%',
  '%%m:a:start%%m:b:start%%![x](y)%%m:b:end%%',
  '%%m:a:start%%![![[x](y)%%m:a:end%%',
  '%%m:a:start%%![[x]](y)%%m:a:end%%',
  '%%m:a:start%%![a]((x)(y)%%m:a:end%%',
  '%%m:a:start%%![a]((x)(y))%%m:a:end%%',
  '%%m:a:start%%![a](((x)))%%m:a:end%%',
  '%%m:a:end%%m:b:start%% {%c: a ,b%}{%/c%}%%m:%%m:c:end%%',
];

const ALPHABET = [
  '%%m:', '{%c:', '{%/c%}', ':start%%', ':end%%', '%}', '%', '{', '}', ':', 'a', 'b', ',', '-', '_', ' ', '\t', '\n', '\r',
  '\u2028', '\u00a0', '#', '###', '#######', '!', '[', ']', '(', ')', '![', '](', '![[', ']]', 'x y', '%%m:a:start%%',
  '%%m:a:end%%', '%%m:b:end%%', '{%c:a%}', '```\n', '![a](b)',
];

const fuzz = (check: (text: string) => void): void => {
  for (const text of [...CASES, ...FIXTURES.map((f) => f.markdown)]) check(text);
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...ALPHABET), { maxLength: 30 }), (parts) => {
      check(parts.join(''));
    }),
    { numRuns: 5000 },
  );
};

/** Every call a replacer gets, and what it returns. */
function recorder(): { calls: unknown[][]; replacer: (...args: unknown[]) => string } {
  const calls: unknown[][] = [];
  return { calls, replacer: (...args) => `<${calls.push(args)}>` };
}

describe('comment-marker scans are golden-equal to moss\'s regexes @p:agt-1 @p:tech-4', () => {
  it('normalizeCommentWrappedAtxHeadings', () => {
    fuzz((text) => expect(normalizeCommentWrappedAtxHeadings(text), JSON.stringify(text)).toBe(moss.normalizeCommentWrappedAtxHeadings(text)));
  });

  it('normalizeCommentWrappedImages', () => {
    fuzz((text) => expect(normalizeCommentWrappedImages(text), JSON.stringify(text)).toBe(moss.normalizeCommentWrappedImages(text)));
  });

  it('COMMENT_WRAPPED_IMAGE: the same matches, groups and offsets', () => {
    fuzz((text) => {
      const ours = recorder();
      const theirs = recorder();
      const result = replaceCommentWrappedImages(text, ours.replacer);
      expect(result, JSON.stringify(text)).toBe(text.replace(moss.COMMENT_WRAPPED_IMAGE, theirs.replacer));
      expect(ours.calls, JSON.stringify(text)).toEqual(theirs.calls);
    });
  });

  it('findMarkers', () => {
    fuzz((text) => expect(scanCommentMarkers(text), JSON.stringify(text)).toEqual(moss.findMarkers(text)));
  });

  it('markerIdList', () => {
    fuzz((text) => expect(commentMarkerIdList(text), JSON.stringify(text)).toBe(moss.markerIdList(text)));
  });

  it('$normalizeFormatWhitespace', () => {
    const run = (normalize: (node: TextNode) => void, text: string, sibling: boolean): unknown => {
      const editor = createHeadlessEditor({ onError: (error) => { throw error; } });
      let children: unknown;
      editor.update(() => {
        const paragraph = $createParagraphNode();
        const node = $createTextNode(text).setFormat('bold');
        paragraph.append(node);
        if (sibling) paragraph.append($createTextNode('tail'));
        $getRoot().append(paragraph);
        normalize(node);
        children = paragraph.getChildren().map((child) => [child.getTextContent(), $isTextNode(child) ? child.getFormat() : null]);
      }, { discrete: true });
      return children;
    };
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t', 'a', 'b c', '-', '#', '1.', '>', '[ ]', '\u00a0', '\n'), { minLength: 1, maxLength: 12 }),
        fc.boolean(),
        (parts, sibling) => {
          const text = parts.join('');
          expect(run($normalizeFormatWhitespace, text, sibling), JSON.stringify(text)).toEqual(run(moss.$normalizeFormatWhitespace, text, sibling));
        },
      ),
      { numRuns: 2000 },
    );
  });
});
