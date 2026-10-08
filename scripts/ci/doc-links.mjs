#!/usr/bin/env node
// Fails when a markdown doc cites a repo path or symbol that does not exist (T8.4, MIGRATION.md).
//   node scripts/ci/doc-links.mjs [doc.md ...]      default: MIGRATION.md
// A citation is a code span that starts with a top-level repo entry (`packages/sync/src/doc-do.ts`), optionally
// naming a symbol declared in that file (`packages/sync/src/doc-do.ts#DocDO`), or a moss path at the pin
// (`moss:packages/desktop/src/renderer/App.tsx`), which must be vendored or named by a `ported-from` header.
// A `<placeholder>` in a path checks only the directory before it. Relative markdown links must resolve too.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', '.refs', '.cache', 'dist', '.wrangler', '.claude']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

const escapeRegExp = (text) => text.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');

function topLevel(repo) {
  return new Set(readdirSync(repo).filter((name) => !SKIP_DIRS.has(name)));
}

// Splits one line into its code spans (a run of n backticks closed by the next run of exactly n) and the rest.
function splitSpans(line) {
  const spans = [];
  let plain = '';
  let at = 0;
  while (at < line.length) {
    const open = line.indexOf('`', at);
    if (open < 0) break;
    let ticks = open;
    while (line[ticks] === '`') ticks++;
    const fence = line.slice(open, ticks);
    let close = line.indexOf(fence, ticks);
    while (close >= 0 && line[close + fence.length] === '`') {
      let end = close;
      while (line[end] === '`') end++;
      close = line.indexOf(fence, end);
    }
    if (close < 0) {
      plain += line.slice(at, ticks);
      at = ticks;
      continue;
    }
    plain += line.slice(at, open);
    spans.push(line.slice(ticks, close).trim());
    at = close + fence.length;
  }
  return { spans, plain: plain + line.slice(at) };
}

// Code spans outside fenced blocks, and inline links, with their line numbers.
export function citations(text) {
  const spans = [];
  const links = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const parts = splitSpans(line);
    for (const span of parts.spans) spans.push({ line: index + 1, text: span });
    for (const match of parts.plain.matchAll(/\]\(([^)\s]+)\)/g)) links.push({ line: index + 1, target: match[1] });
  });
  return { spans, links };
}

// A symbol is declared when the file defines it (function, class, const, type, interface, enum, a method or a
// field) or, for a non-source file, merely mentions it.
export function declares(source, symbol, path) {
  const name = escapeRegExp(symbol);
  if (!SOURCE.test(path)) return new RegExp(`(?:^|[^\\w$])${name}(?![\\w$])`).test(source);
  const declaration = new RegExp(`(?:function\\*?|const|let|var|class|type|interface|enum|namespace)\\s+${name}(?![\\w$])`);
  const member = new RegExp(`^\\s*(?:(?:export|default|public|private|protected|readonly|static|async|override|get|set)\\s+)*#?${name}\\s*[(:<=?]`, 'm');
  const reexport = new RegExp(`export\\s*\\{[^}]*(?<![\\w$])${name}(?![\\w$])[^}]*\\}`);
  return declaration.test(source) || member.test(source) || reexport.test(source);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (SOURCE.test(entry.name)) yield path;
  }
}

// moss paths outside the vendor tree (Electron main) that a port names in its `ported-from` header.
export function portedPaths(repo) {
  const paths = new Set();
  for (const root of ['packages', 'apps']) {
    if (!existsSync(join(repo, root))) continue;
    for (const file of walk(join(repo, root))) {
      const head = readFileSync(file, 'utf8').split('\n', 12).join('\n');
      if (!head.includes('ported-from:')) continue;
      for (const match of head.matchAll(/packages\/[\w./-]+/g)) paths.add(match[0]);
    }
  }
  return paths;
}

function checkPath(repo, path) {
  const hole = path.indexOf('<');
  if (hole >= 0) {
    const dir = path.slice(0, path.lastIndexOf('/', hole) + 1);
    return dir && existsSync(join(repo, dir)) && statSync(join(repo, dir)).isDirectory() ? null : `no directory ${dir || path}`;
  }
  if (/[*{}]/.test(path)) return `not a checkable path: ${path}`;
  const full = join(repo, path);
  if (!existsSync(full)) return `no such path: ${path}`;
  if (path.endsWith('/') && !statSync(full).isDirectory()) return `not a directory: ${path}`;
  return null;
}

export function checkText(text, { repo = REPO, docDir = repo, ported } = {}) {
  const roots = topLevel(repo);
  const problems = [];
  const { spans, links } = citations(text);
  for (const { line, text: span } of spans) {
    if (/\s/.test(span)) continue;
    if (span.startsWith('moss:')) {
      const path = span.slice('moss:'.length);
      ported ??= portedPaths(repo);
      if (!existsSync(join(repo, 'vendor/moss', path)) && !ported.has(path)) {
        problems.push(`line ${line}: moss path neither vendored nor ported: ${path}`);
      }
      continue;
    }
    const [path, symbol, extra] = span.split('#');
    const first = path.split('/')[0];
    if (!roots.has(first) || (!path.includes('/') && !statSync(join(repo, first)).isFile())) continue;
    if (extra !== undefined) {
      problems.push(`line ${line}: more than one # in ${span}`);
      continue;
    }
    const missing = checkPath(repo, path);
    if (missing) {
      problems.push(`line ${line}: ${missing}`);
      continue;
    }
    if (symbol === undefined) continue;
    const full = join(repo, path);
    if (statSync(full).isDirectory()) {
      problems.push(`line ${line}: a symbol needs a file, not a directory: ${span}`);
    } else if (!declares(readFileSync(full, 'utf8'), symbol, path)) {
      problems.push(`line ${line}: ${path} does not declare ${symbol}`);
    }
  }
  for (const { line, target } of links) {
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
    const file = resolve(docDir, target.split('#')[0]);
    if (!existsSync(file)) problems.push(`line ${line}: broken link ${target}`);
  }
  return problems;
}

export function checkDoc(file, repo = REPO) {
  const full = resolve(repo, file);
  return checkText(readFileSync(full, 'utf8'), { repo, docDir: dirname(full) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const docs = process.argv.slice(2);
  let failed = false;
  for (const doc of docs.length > 0 ? docs : ['MIGRATION.md']) {
    const problems = checkDoc(doc);
    for (const problem of problems) console.error(`${relative(REPO, resolve(REPO, doc))}: ${problem}`);
    failed ||= problems.length > 0;
  }
  if (failed) process.exit(1);
  console.log('doc links: every cited path and symbol exists');
}
