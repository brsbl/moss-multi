// Tailwind generates only the utilities it finds in its content globs, so a className file outside them ships
// unstyled (the login card rendered full-bleed, L§4.1). Every file that writes a className into the client
// bundle must match apps/web/tailwind.config.ts (A§4.3).
import { globSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(WEB, '../..');

/** Source trees the client bundle draws from. */
const CLIENT_ROOTS = [
  'apps/web/src',
  'packages/ui/src',
  'vendor/moss/packages/desktop/src/renderer',
  'vendor/moss/packages/desktop/src/common',
  'vendor/moss/packages/shared/src',
];

const SOURCE = /\.(tsx?|jsx?|html)$/;
const SKIP = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WRITES_CLASS = /\bclassName\b|\bclass=["'{]/;

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
    return SOURCE.test(entry.name) && !SKIP.test(entry.name) ? [path] : [];
  });
}

/** The config's content globs, relative to apps/web (its cwd and, with `relative: true`, its directory). */
async function contentGlobs(): Promise<string[]> {
  // A computed specifier keeps tsc out of moss's tailwind config.
  const href = pathToFileURL(join(WEB, 'tailwind.config.ts')).href;
  const config = ((await import(href)) as { default: { content: string[] | { files: string[] } } }).default;
  const content = Array.isArray(config.content) ? config.content : config.content.files;
  return content.filter((glob): glob is string => typeof glob === 'string');
}

describe('Tailwind content coverage', () => {
  it('every client file that writes a className matches a content glob', async () => {
    const covered = new Set((await contentGlobs()).flatMap((glob) => globSync(glob, { cwd: WEB }).map((path) => join(WEB, path))));
    const writers = CLIENT_ROOTS.flatMap((root) => walk(join(REPO, root))).filter((path) => WRITES_CLASS.test(readFileSync(path, 'utf8')));
    expect(writers.length, 'the scan found className writers').toBeGreaterThan(100);
    const outside = writers.filter((path) => !covered.has(path)).map((path) => relative(REPO, path));
    expect(outside, 'files outside apps/web/tailwind.config.ts content globs').toEqual([]);
  });
});
