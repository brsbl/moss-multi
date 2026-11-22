// The linear rewrites in note-store.port.ts, moss's comment-marker functions and the paste plugin's URL scan (docs/METHOD.md): golden-equal to moss's
// regexes over fixtures and fuzz strings, and linear on note text and clipboard HTML an attacker writes.
/* eslint-disable regexp/no-super-linear-backtracking, regexp/no-super-linear-move -- moss's patterns are the golden references */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { doubling, expectLinearTime } from '../../../../scripts/lib/linear-time.mjs';
import { URL_IN_HTML } from '../substitutes/url-in-html';
import { MOSS_CANVAS_FENCE_PATTERN_SOURCE } from '@moss-desktop/common/markdown-fences';
import { migrateLegacyCommentMarkersToModern, stripCommentMarkerTokens } from '@moss-desktop/common/comment-markers';
import { containsCommentAnchors, extractCommentAnchorIds, stripCommentAnchors } from '@moss-desktop/common/markdown-layers';
import {
  blankMarkdownLinks,
  blankWikiLinks,
  classifyNoteContentType,
  codeBlockSpans,
  countMarkdownTableSeparators,
  imageMarkdownSpans,
} from './note-store.port';
import { deriveRead, planSave, type RendererSnapshot } from './pipeline';

const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;
const spans = (text: string, pattern: RegExp): [number, number][] => [...text.matchAll(pattern)].map((match) => [match.index!, match.index! + match[0].length]);
const MOSS_CODE_BLOCK_REGEX = new RegExp('```(?!(?:moss-chart|' + MOSS_CANVAS_FENCE_PATTERN_SOURCE + ')\\b)[^\\n]*\\n[\\s\\S]*?```', 'g');

// moss's marker functions at the pin (common/comment-markers.ts, common/markdown-layers.ts), the golden references for
// the linear versions vendor/patches records.
const ID_LIST = '[A-Za-z0-9_,\\-\\s]+?';
const LEGACY_OPEN = `\\{%c:\\s*(${ID_LIST})\\s*%\\}`;
const LEGACY_CLOSE = '\\{%\\/c%\\}';
const MODERN_OPEN = `%%m:\\s*(${ID_LIST})\\s*:start%%`;
const MODERN_CLOSE = `%%m:\\s*(${ID_LIST})\\s*:end%%`;
const MODERN_BOUNDARY = `%%m:\\s*(${ID_LIST})\\s*:(start|end)%%`;
const mossMigrate = (markdown: string): { markdown: string; migrated: boolean } => {
  const tokenRe = new RegExp(`${LEGACY_OPEN}|${LEGACY_CLOSE}`, 'g');
  const activeStack: string[][] = [];
  let lastIndex = 0;
  let migrated = false;
  let output = '';
  let match: RegExpExecArray | null;
  const parseIds = (raw: string) => [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))];
  const serialize = (ids: string[], boundary: string) => (ids.length === 0 ? '' : `%%m:${ids.join(',')}:${boundary}%%`);
  while ((match = tokenRe.exec(markdown)) !== null) {
    output += markdown.slice(lastIndex, match.index);
    if (match[1] !== undefined) {
      const ids = parseIds(match[1]);
      if (ids.length === 0) {
        output += match[0];
      } else {
        activeStack.push(ids);
        output += serialize(ids, 'start');
        migrated = true;
      }
    } else if (activeStack.length > 0) {
      output += serialize(activeStack.pop() ?? [], 'end');
      migrated = true;
    } else {
      output += match[0];
    }
    lastIndex = match.index + match[0].length;
  }
  if (!migrated) return { markdown, migrated: false };
  return { markdown: output + markdown.slice(lastIndex), migrated: true };
};
const mossStripTokens = (markdown: string) => markdown.replace(new RegExp(`${LEGACY_OPEN}|${LEGACY_CLOSE}|${MODERN_BOUNDARY}`, 'g'), '');
const mossStripAnchors = (markdown: string) =>
  [LEGACY_OPEN, LEGACY_CLOSE, MODERN_OPEN, MODERN_CLOSE].reduce((text, source) => text.replace(new RegExp(source, 'g'), ''), markdown);
const mossAnchorIds = (markdown: string) => {
  const result = new Set<string>();
  for (const source of [LEGACY_OPEN, MODERN_OPEN]) {
    for (const match of markdown.matchAll(new RegExp(source, 'g'))) {
      for (const id of match[1]!.split(',').map((entry) => entry.trim()).filter(Boolean)) result.add(id);
    }
  }
  return [...result];
};
const mossContainsAnchors = (markdown: string) => new RegExp(LEGACY_OPEN).test(markdown) || new RegExp(MODERN_OPEN).test(markdown);

const MARKER_ALPHABET = ['{', '}', '%', '/', 'c', 'm', ':', '{%', '{%c:', '{%/c%}', '%%m:', '%}', ':start%%', ':end%%', 'a', 'B', '1', '_', ',', '-', ' ', '\t', '\n', '\r', '\u00a0', '\u2028', '\ufeff', '!'];
// A marker opener and a run of blanks (moss's regexes are cubic there), and runs of openers and whole markers.
const MARKER_ATTACKS: ((n: number) => string)[] = [
  (n) => `{%c:${' '.repeat(n)}`,
  (n) => `%%m:${'\t'.repeat(n)}`,
  (n) => `x{%c:${'\n'.repeat(n)}x`,
  (n) => `%%m:${'\n'.repeat(n)}:start`,
  (n) => `{%c:${' a'.repeat(n / 2)}%`,
  (n) => '{%c:'.repeat(n / 4),
  (n) => '%%m:'.repeat(n / 4),
  (n) => '{%c: '.repeat(n / 5),
  (n) => '%%m:a:sta'.repeat(n / 9),
  (n) => '{%c:a%}'.repeat(n / 7),
  (n) => '%%m:a:start%%m:a:end%%'.repeat(n / 22),
  (n) => '{%{%c:a%}/c%}'.repeat(n / 13),
];

const REWRITES: [string, (text: string) => unknown, (text: string) => unknown, string[], ((n: number) => string)[]][] = [
  [
    'the table separator count',
    countMarkdownTableSeparators,
    (text) => count(text, /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*$/gm),
    ['|', '-', '---', ':', ' ', '\t', '\n', '\r', '\r\n', '\u2028', '\u00a0', 'a', '|---|---', '| --- |', '---|', ':---:'],
    [
      (n) => '\n'.repeat(n),
      (n) => ' '.repeat(n),
      (n) => `|${'\n'.repeat(n)}`,
      (n) => '|---\n'.repeat(n / 5),
      (n) => '-'.repeat(n),
      (n) => '---|\n'.repeat(n / 5),
      (n) => ':---|\r\n'.repeat(n / 7),
      (n) => `${'\n'.repeat(n / 2)}|${' '.repeat(n / 2)}`,
      (n) => `${'\n'.repeat(n / 2)}---|${' '.repeat(n / 2)}`,
      (n) => '---|---a\n'.repeat(n / 9),
    ],
  ],
  [
    'the fenced code block scan',
    codeBlockSpans,
    (text) => spans(text, MOSS_CODE_BLOCK_REGEX),
    ['`', '```', '\n', ' ', 'a', 'moss-chart', 'moss-canvas', '-', '```moss-chart', '```js\n'],
    [(n) => '`'.repeat(n), (n) => '```a'.repeat(n / 4), (n) => '```moss-chart'.repeat(n / 13), (n) => `\`\`\`\n${'`'.repeat(n)}`],
  ],
  [
    'the image scan',
    imageMarkdownSpans,
    (text) => spans(text, /!\[[^\]]*\]\((?:[^()\n]|\\\(|\\\))*\)/g),
    ['!', '[', ']', '(', ')', '\\', '\n', 'a', '![', '](', '\\(', '![a](b)'],
    [(n) => '!['.repeat(n / 2), (n) => '![a]('.repeat(n / 5), (n) => `![a](${'a'.repeat(n)}`, (n) => '[!['.repeat(n / 3)],
  ],
  [
    'blankWikiLinks',
    blankWikiLinks,
    (text) => text.replace(/\[\[[^\]]+\]\]/g, ' '),
    ['[', ']', 'a', '[[', ']]'],
    [(n) => '['.repeat(n), (n) => '[[a'.repeat(n / 3), (n) => `[[${'a'.repeat(n)}]`],
  ],
  [
    'blankMarkdownLinks',
    blankMarkdownLinks,
    (text) => text.replace(/\[[^\]]*\]\((?:[^()\n]|\\\(|\\\))*\)/g, ' '),
    ['[', ']', '(', ')', '\\', '\n', 'a', '](', '\\(', '\\)'],
    [(n) => '['.repeat(n), (n) => '[a]('.repeat(n / 4), (n) => `[a](${'a'.repeat(n)}`, (n) => `[a](${'\\('.repeat(n / 2)}`, (n) => '[](\\('.repeat(n / 5)],
  ],
  [
    'URL_IN_HTML',
    (text) => [...text.matchAll(URL_IN_HTML)].map((match) => [match.index! + match[0].length - match[1]!.length, match[1]]),
    (text) => [...text.matchAll(/[a-z][a-z\d+.-]*:[^\s"'<>]+/gi)].map((match) => [match.index, match[0]]),
    ['a', 'Z', '1', '+', '.', '-', ':', '/', ' ', '"', '<', '>', 'https://h/x', '1a:b'],
    [(n) => 'a'.repeat(n), (n) => `1${'a1'.repeat(n / 2)}`, (n) => '-'.repeat(n)],
  ],
  ['stripCommentAnchors', stripCommentAnchors, mossStripAnchors, MARKER_ALPHABET, MARKER_ATTACKS],
  ['migrateLegacyCommentMarkersToModern', migrateLegacyCommentMarkersToModern, mossMigrate, MARKER_ALPHABET, MARKER_ATTACKS],
  ['extractCommentAnchorIds', (text) => [...extractCommentAnchorIds(text)], mossAnchorIds, MARKER_ALPHABET, MARKER_ATTACKS],
  ['containsCommentAnchors', containsCommentAnchors, mossContainsAnchors, MARKER_ALPHABET, MARKER_ATTACKS],
  ['stripCommentMarkerTokens', stripCommentMarkerTokens, mossStripTokens, MARKER_ALPHABET, MARKER_ATTACKS],
];

const FIXTURES = [
  '',
  '| a | b |\n| --- | :---: |\n| 1 | 2 |\n\n|---|---\n\n   \n\n  |---|---|\n',
  '|\n---|---\n---|\n\n\n',
  '---|\n---|\n---|\n',
  '---|\n---\n\n---|---  \n  |\n:---:\r\n',
  'x ---|---\n\u2028 | ---|---|\u2029',
  '```js\nconst a = 1;\n```\n```moss-chart\n{}\n```\n``` \nb```',
  'An ![image](a.png) and ![x](a\\(b\\)) ![[a]](b) !![y](z) ![no](\n)',
  'See [[Plan]] and [x](y) and [z](a\\(b\\)c) and [w](a(b) and [v](\n) and [[]] [[a]b]]',
  '<p>moss-asset://n/a.png <img src="https://bb.example/media/x?a=1&amp;b=2">9a:b 1+x.y:z</p>',
  'A {%c:c1%}b{%/c%} and %%m:c2, c3:start%%d%%m:c2, c3:end%% {%/c%}',
  '{%c:  %}{%c: a b \n%}x{%c:a,a,,b%}{%/c%}{%/c%}{%/c%}{%c:%}',
  '{%{%c:a%}/c%} %%m:a:start%%m:b:start%%m:b:end%% %%%m:a:end%%%',
  '{%c:\u00a0a\u2028%}y{%c:a!%}{%c: a%}%%m: a :start%%%%m:a:stop%%',
];

/** Fastest of three per size, so a GC pause on a busy runner is not read as growth. */
function expectLinear(run: (text: string) => unknown, attack: (n: number) => string) {
  return expectLinearTime({
    shape: String(attack),
    sizes: doubling(16 * 1024, 1024 * 1024),
    warmup: [8 * 1024],
    samples: 3,
    slack: 25,
    measure: (n) => {
      const text = attack(n);
      const start = performance.now();
      run(text);
      return performance.now() - start;
    },
  });
}

/** One save of `body` over a plain note, through the editor's whole save path. */
function saveOf(body: string) {
  const meta = JSON.stringify({ id: 'n1', title: 'Plan', createdAt: 1, updatedAt: 1, stickyTabs: [], frontmatterMeta: {}, folderPath: 'Notes' });
  const disk = {
    files: { markdown: '# Plan\n', comments: null, layout: null, meta },
    location: { folderPath: 'Notes', folderName: 'Plan', markdownName: 'Plan.md' },
    version: 'v1',
    metaVersion: 'm1',
  };
  const read = deriveRead(disk as Parameters<typeof deriveRead>[0], '# Plan\n', []);
  const snapshot: RendererSnapshot = {
    content: `# Plan\n\n${body}`,
    commentMetadata: {},
    layoutMetadata: { version: 1, tableCount: 0, tables: [] },
    intents: { frontmatterMetaUpdates: {}, commentColors: {} },
  };
  return () => planSave(read, snapshot, { now: 2 });
}

// A comment-marker opener followed by a run of whitespace: moss's marker regexes put three quantifiers over it.
const MARKER_OPENERS = ['{%c:', '%%m:'];
const WHITESPACE = [' ', '\t', '\n'];
const MARKER_BLANK_RUNS = MARKER_OPENERS.flatMap((opener) => [
  (n: number) => `x${opener}${' '.repeat(n)}x`,
  (n: number) => `x${opener}${'\t'.repeat(n)}x`,
  (n: number) => `x${opener}${'\n'.repeat(n)}x`,
]);

describe("linear rewrites of moss's note-store regexes", () => {
  describe('a save over a comment-marker opener and 2,000 whitespace characters', () => {
    for (const opener of MARKER_OPENERS) {
      for (const space of WHITESPACE) {
        const text = `x${opener}${space.repeat(2000)}x`;
        const runs: [string, () => unknown][] = [
          ['planSave', saveOf(text)],
          ['classifyNoteContentType', () => classifyNoteContentType(text)],
          ['migrateLegacyCommentMarkersToModern', () => migrateLegacyCommentMarkersToModern(text)],
        ];
        for (const [name, run] of runs) {
          it(`${name} on ${JSON.stringify(opener)} and ${JSON.stringify(space)} x 2000 takes under 200 ms`, () => {
            const start = performance.now();
            run();
            expect(performance.now() - start).toBeLessThan(200);
          }, 120_000);
        }
      }
    }
  });

  for (const [name, scan, regex, alphabet, attacks] of REWRITES) {
    it(`${name} is golden-equal to the regex it replaced`, () => {
      for (const text of FIXTURES) expect(scan(text), JSON.stringify(text)).toEqual(regex(text));
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 30 }), (parts) => {
          const text = parts.join('');
          expect(scan(text)).toEqual(regex(text));
        }),
        { numRuns: 20000 },
      );
    });
    it(`${name} is linear on attacker-written text`, async () => {
      for (const attack of attacks) await expectLinear(scan, attack);
    }, 120_000);
  }

  it('classifyNoteContentType is linear on attacker-written notes', async () => {
    for (const attack of [
      (n: number) => '['.repeat(n),
      (n: number) => `x\n${'\n'.repeat(n)}`,
      (n: number) => '[a]('.repeat(n / 4),
      (n: number) => '---|\n'.repeat(n / 5),
      (n: number) => '`'.repeat(n),
      (n: number) => '!['.repeat(n / 2),
      ...MARKER_BLANK_RUNS,
    ]) {
      await expectLinear(classifyNoteContentType, attack);
    }
  }, 120_000);

  it('a save is linear on a comment-marker opener and a run of blanks', async () => {
    for (const attack of MARKER_BLANK_RUNS) await expectLinear((text) => saveOf(text)(), attack);
  }, 120_000);
});
