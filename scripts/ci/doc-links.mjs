#!/usr/bin/env node
// Fails when a markdown doc cites a repo path or symbol that does not exist (T8.4, MIGRATION.md).
//   node scripts/ci/doc-links.mjs [doc.md ...]      default: MIGRATION.md
// A citation is a code span that starts with a top-level repo entry (`packages/sync/src/doc-do.ts`) or reads as a
// repo path whose root may be gone (`gone/file.ts`, `GONE.md`), optionally
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

const skipSpace = (source, at) => {
  while (at < source.length && /\s/.test(source[at])) at++;
  return at;
};

// The index of the bracket closing the one at `at`, or -1.
function closing(source, at, open, close) {
  for (let depth = 0, i = at; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i;
  }
  return -1;
}

// What follows a member's name declares it: a field (`?: T`, `!: T`, `: T`, `= v`) or a method (`<T>(params) {` or
// `(params): T {`). A call statement (`name(args);`) does not.
function declaresMember(source, at) {
  let i = skipSpace(source, at);
  if (source[i] === '?' || source[i] === '!') i = skipSpace(source, i + 1);
  if (source[i] === ':') return true;
  if (source[i] === '=') return source[i + 1] !== '=' && source[i + 1] !== '>';
  if (source[i] === '<') {
    i = closing(source, i, '<', '>');
    if (i < 0) return false;
    i = skipSpace(source, i + 1);
  }
  if (source[i] !== '(') return false;
  i = closing(source, i, '(', ')');
  if (i < 0) return false;
  i = skipSpace(source, i + 1);
  return source[i] === '{' || source[i] === ':';
}

// A symbol is declared when the file defines it (function, class, const, type, interface, enum, a method or a
// field) or, for a non-source file, merely mentions it.
export function declares(source, symbol, path) {
  const name = escapeRegExp(symbol);
  if (!SOURCE.test(path)) return new RegExp(`(?:^|[^\\w$])${name}(?![\\w$])`).test(source);
  const declaration = new RegExp(`(?:function\\*?|const|let|var|class|type|interface|enum|namespace)\\s+${name}(?![\\w$])`);
  const member = new RegExp(`^[ \\t]*(?:(?:export|default|public|private|protected|readonly|static|async|override|declare|abstract|get|set)\\s+)*#?${name}(?![\\w$])`, 'gm');
  const reexport = new RegExp(`export\\s*\\{[^}]*(?<![\\w$])${name}(?![\\w$])[^}]*\\}`);
  if (declaration.test(source) || reexport.test(source)) return true;
  for (const match of source.matchAll(member)) if (declaresMember(source, match.index + match[0].length)) return true;
  return false;
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
    return existsSync(join(repo, dir)) && statSync(join(repo, dir)).isDirectory() ? null : `no directory ${dir}`;
  }
  if (/[*{}]/.test(path)) return `not a checkable path: ${path}`;
  const full = join(repo, path);
  if (!existsSync(full)) return `no such path: ${path}`;
  if (path.endsWith('/') && !statSync(full).isDirectory()) return `not a directory: ${path}`;
  return null;
}

const EXTENSION = /\.(?:md|[cm]?[jt]sx?|json|jsonc|ya?ml|toml|patch|sh|css|html|sql|txt)$/;

// A repo path by its syntax, whether or not its root still exists: a relative path to a file with a known extension
// (`gone/file.ts`), or a root-level doc in capitals (`GONE.md`). URLs, absolute, `@scope` and `.dot` paths are not.
function looksLikePath(path) {
  if (path.includes('/')) return /^[\w-]/.test(path) && !path.includes('://') && EXTENSION.test(path);
  return /^[A-Z][A-Z0-9_-]*\.md$/.test(path);
}

export function checkText(text, { repo = REPO, docDir = repo, ported } = {}) {
  const roots = topLevel(repo);
  const problems = [];
  const { spans, links } = citations(text);
  for (const { line, text: span } of spans) {
    if (/\s/.test(span)) continue;
    if (span.startsWith('moss:')) {
      const path = span.slice('moss:'.length);
      if (path.includes('<')) {
        const missing = checkPath(join(repo, 'vendor/moss'), path);
        if (missing) problems.push(`line ${line}: moss ${missing}`);
        continue;
      }
      ported ??= portedPaths(repo);
      if (!existsSync(join(repo, 'vendor/moss', path)) && !ported.has(path)) {
        problems.push(`line ${line}: moss path neither vendored nor ported: ${path}`);
      }
      continue;
    }
    const [path, symbol, extra] = span.split('#');
    const first = path.split('/')[0];
    const underRoot = roots.has(first) && (path.includes('/') || statSync(join(repo, first)).isFile());
    if (!underRoot && !looksLikePath(path)) continue;
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
