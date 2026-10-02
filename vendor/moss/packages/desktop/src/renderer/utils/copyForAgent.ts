// ported-from: packages/desktop/src/renderer/utils/copyForAgent.ts @ 762abb777
export const buildCopyForAgentMessage = (notePath: string): string =>
  [
    "! Moss is shared memory between you and the user. It's a local markdown notes app where you both read and write.",
    '',
    "## I'm working in",
    `\`${notePath}\``,
    '',
    '---',
    '',
    '## How notes work',
    'Notes live at `~/Moss/Notes/`. Each note is a folder with a markdown file inside, usually named `<Title>.md` to match the note title.',
    'To create a note, write `<Title>.md` inside a new directory under `~/Moss/Notes/`. Moss detects new directories automatically.',
    '',
    'Read `~/Moss/.moss/skills/writing-guidelines.md` and `notes.md` first for note quality, structure, and core syntax, then the focused modules (frontmatter, comments, links, formulas, canvas, html) in `~/Moss/.moss/skills/` as needed.',
    '',
    '---',
    '',
    '## Your workspace',
    'Create a workspace folder named after yourself for plans, research, and logs. Add subfolders however you see fit to stay organized.',
    '',
    'Save this to your `CLAUDE.md` or `AGENTS.md` so you remember across sessions.',
  ].join('\n');
