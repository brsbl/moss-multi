#!/usr/bin/env node
// Builds the Ladle oracle (A§20, A§22 OA1 fallback): moss@pin's own files from `moss-vendor.mjs pristine`, plus
// the one preamble edit S-test §5.1 allows (main.tsx's font imports, which Ladle lacks), then `ladle build`.
//   node e2e/parity/oracle/build.mjs <outDir>
// Needs `pnpm install --frozen-lockfile --ignore-workspace` in e2e/parity/oracle first.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../..');
const TREE = join(HERE, 'moss');
const STYLES_IMPORT = "import '../packages/desktop/src/renderer/styles.css';";
const UNVENDORED_STORY = 'packages/desktop/stories/EditorMock.stories.tsx';

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
}

/** The side-effect CSS imports at the top of main.tsx, in order (fonts; styles.css comes later in the file). */
export function fontImports(mainTsx) {
  const lines = [];
  for (const line of mainTsx.split('\n')) {
    if (/^import\s+\w/.test(line)) break; // the first binding import (React) ends the preamble
    const match = /^import\s+'([^']+\.css)';\s*$/.exec(line);
    if (match && !match[1].startsWith('.')) lines.push(`import '${match[1]}';`);
  }
  return lines;
}

/** Inserts the font imports before the stylesheet import, so the cascade matches main.tsx. */
export function withPreamble(components, fonts) {
  if (!components.includes(STYLES_IMPORT)) throw new Error('.ladle/components.tsx no longer imports styles.css; re-audit the preamble');
  return components.replace(STYLES_IMPORT, `${fonts.join('\n')}\n${STYLES_IMPORT}`);
}

function main(out) {
  if (!out) throw new Error('usage: build.mjs <outDir>');
  rmSync(TREE, { recursive: true, force: true });
  run(process.execPath, [join(REPO, 'scripts/moss-vendor.mjs'), 'pristine', TREE, '--root', 'moss'], REPO);
  const fonts = fontImports(readFileSync(join(TREE, 'packages/desktop/src/renderer/main.tsx'), 'utf8'));
  if (fonts.length < 6) throw new Error(`expected main.tsx's 6 font imports, found ${fonts.length}`);
  const componentsPath = join(TREE, '.ladle/components.tsx');
  writeFileSync(componentsPath, withPreamble(readFileSync(componentsPath, 'utf8'), fonts));
  // This story renders moss's packages/web, which is not vendored (A§2.1); no target uses it.
  rmSync(join(TREE, UNVENDORED_STORY));
  // The node-family parity story (A§20) and the note it renders; oracle-only, never vendored.
  copyFileSync(join(HERE, 'DemoNote.stories.tsx'), join(TREE, 'packages/desktop/stories/DemoNote.stories.tsx'));
  copyFileSync(join(REPO, 'e2e/fixtures/demo-note.md'), join(TREE, 'packages/desktop/stories/demo-note.md'));
  // The comment parity story (T4.3) and its note with one thread; oracle-only, never vendored.
  copyFileSync(join(HERE, 'CommentNote.stories.tsx'), join(TREE, 'packages/desktop/stories/CommentNote.stories.tsx'));
  for (const file of ['comment-note.md', 'comment-note.comments.json']) copyFileSync(join(REPO, 'e2e/fixtures', file), join(TREE, 'packages/desktop/stories', file));
  const outDir = resolve(out);
  // Ladle joins --outDir onto its cwd.
  const viteConfig = join(HERE, 'vite.oracle.mjs');
  run(join(HERE, 'node_modules/.bin/ladle'), ['build', '--outDir', relative(TREE, outDir), '--viteConfig', viteConfig], TREE);
  const preamble = createHash('sha256').update(fonts.join('\n')).digest('hex').slice(0, 12);
  writeFileSync(join(outDir, 'oracle.json'), `${JSON.stringify({ pin: '762abb777', source: 'pristine', fonts, preamble }, null, 2)}\n`);
  console.log(`oracle: ${outDir} (preamble ${preamble})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv[2]);
