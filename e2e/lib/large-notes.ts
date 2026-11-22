// The near-cap notes the j01 paste and large-note journeys import, shared with the DocDO memory measurement
// (scripts/measure-memory.mjs), so the measured notes are the journeys' own. No imports: Node loads this file directly.

export const LAST = 'Last line of the paste.';

const WORDS = ['moss', 'grows', 'on', 'the', 'north', 'side', 'of', 'old', 'stones', 'and', 'keeps', 'water', 'through', 'dry',
  'weeks', 'while', 'notes', 'collect', 'ideas', 'from', 'many', 'people', 'working', 'together', 'in', 'one', 'shared', 'document'];

/** A sentence of about `length` characters. */
export function prose(seed: number, length: number): string {
  let out = '';
  for (let k = 0; out.length < length; k += 1) out += `${out ? ' ' : ''}${WORDS[(seed * 7 + k * 3) % WORDS.length]}`;
  return `${out[0].toUpperCase()}${out.slice(1)}.`;
}

/**
 * Mixed markdown of at least `size` characters, mostly prose as notes are: headings, inline formatting and links,
 * nested lists, checklists, ordered lists, quotes, tables and code. (Formatting every few words would encode past the
 * doc's state cap at 2 MB, A§5.1.)
 */
export function mixedMarkdown(size: number): string {
  const parts = ['Pasted start.'];
  let length = parts[0].length;
  for (let i = 0; length < size; i += 1) {
    const section = [
      `## Section ${i}`,
      `${prose(i, 220)} It has **bold ${i}**, *italic ${i}* and \`code ${i}\`, then a [link ${i}](https://example.invalid/page/${i}). ${prose(i + 1, 220)}`,
      prose(i + 2, 420),
      `- ${prose(i + 3, 60)}\n- ${prose(i + 4, 60)}\n  - ${prose(i + 5, 40)}`,
      ...(i % 3 === 0 ? [`- [ ] open task ${i}\n- [x] done task ${i}`] : []),
      ...(i % 5 === 0 ? [`1. first ${i}\n2. second ${i}`] : []),
      `> ${prose(i + 6, 100)}`,
      ...(i % 4 === 0 ? [`| Name ${i} | Value ${i} |\n| --- | --- |\n| row ${i} | ${i * 7} |`] : []),
      ...(i % 10 === 0 ? [`\`\`\`js\nconst value${i} = ${i};\nconsole.log(value${i});\n\`\`\``] : []),
    ].join('\n\n');
    parts.push(section);
    length += section.length + 2;
  }
  parts.push(LAST);
  return parts.join('\n\n');
}

/** mixedMarkdown's section `i`, with the text a note made from it holds (its characters, as the text limit counts them). */
function mixedSection(i: number): { markdown: string; chars: number } {
  const p = [prose(i, 220), prose(i + 1, 220), prose(i + 2, 420), prose(i + 3, 60), prose(i + 4, 60), prose(i + 5, 40), prose(i + 6, 100)];
  const parts: [string, string[]][] = [
    [`## Section ${i}`, [`Section ${i}`]],
    [`${p[0]} It has **bold ${i}**, *italic ${i}* and \`code ${i}\`, then a [link ${i}](https://example.invalid/page/${i}). ${p[1]}`,
      [`${p[0]} It has bold ${i}, italic ${i} and code ${i}, then a link ${i}. ${p[1]}`]],
    [p[2], [p[2]]],
    [`- ${p[3]}\n- ${p[4]}\n  - ${p[5]}`, [p[3], p[4], p[5]]],
    ...(i % 3 === 0 ? [[`- [ ] open task ${i}\n- [x] done task ${i}`, [`open task ${i}`, `done task ${i}`]] as [string, string[]]] : []),
    ...(i % 5 === 0 ? [[`1. first ${i}\n2. second ${i}`, [`first ${i}`, `second ${i}`]] as [string, string[]]] : []),
    [`> ${p[6]}`, [p[6]]],
    ...(i % 4 === 0 ? [[`| Name ${i} | Value ${i} |\n| --- | --- |\n| row ${i} | ${i * 7} |`, [`Name ${i}`, `Value ${i}`, `row ${i}`, `${i * 7}`]] as [string, string[]]] : []),
    ...(i % 10 === 0 ? [[`\`\`\`js\nconst value${i} = ${i};\nconsole.log(value${i});\n\`\`\``, [`const value${i} = ${i};\nconsole.log(value${i});`]] as [string, string[]]] : []),
  ];
  return { markdown: parts.map(([markdown]) => markdown).join('\n\n'), chars: parts.reduce((sum, [, texts]) => sum + texts.join('').length, 0) };
}

/**
 * mixedMarkdown's sections until the note they make holds as close to `chars` characters of text as a section allows
 * without passing it (the text limit counts text, not markup, A§5.1), with how many it holds.
 */
export function mixedMarkdownOfText(chars: number): { markdown: string; chars: number } {
  const start = 'Pasted start.';
  const parts = [start];
  let total = start.length + LAST.length;
  for (let i = 0; ; i += 1) {
    const section = mixedSection(i);
    if (total + section.chars > chars) break;
    parts.push(section.markdown);
    total += section.chars;
  }
  // Prose up to the count, in one last paragraph.
  const rest = chars - total;
  if (rest > 1) {
    const filler = prose(7, rest).slice(0, rest - 1);
    parts.push(`${filler}.`);
    total += filler.length + 1;
  }
  parts.push(LAST);
  return { markdown: parts.join('\n\n'), chars: total };
}

/** `count` short paragraphs, blank-line separated, ending with a known last line (j01-paste-blocks). */
export function shortParagraphs(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`p${i}`);
  lines.push(LAST);
  return lines.join('\n\n');
}

/** `count` bullet items (j01-paste-list). */
export function flatList(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`- item ${i}`);
  return lines.join('\n');
}

/** A two-column table of `rows` rows; `last` ends the last cell (j01-paste-table). */
export function table(rows: number, last = ''): string {
  const lines = ['| Name | Value |', '| --- | --- |'];
  for (let i = 0; i < rows; i += 1) lines.push(`| row ${i} | value ${i}${i === rows - 1 ? last : ''} |`);
  return lines.join('\n');
}

/** `count` one-line paragraphs (j01-large). */
export const numberedLines = (count: number) => Array.from({ length: count }, (_, i) => `Line ${i} of the note.`).join('\n\n');

/** `count` paragraphs of the race paste, blank-line separated (j01-paste-race). */
export const raceLines = (count: number) => Array.from({ length: count }, (_, i) => `Race line ${i}.`).join('\n\n');
