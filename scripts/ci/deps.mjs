#!/usr/bin/env node
// Bundle-boundary rule (ARCHITECTURE §4.4): nothing statically reachable from the Worker or the converter imports
// a node view, CSS, the @moss/shared barrel, react-dom, jotai, @lexical/code (code-core is the converter's) or the
// Electron API. Type-only imports, imports used only as types (bundlers drop them) and dynamic import() don't count.
//   node scripts/ci/deps.mjs [entry ...]      default entries: the Worker, the sync package, the converter; a missing entry fails
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const DEFAULT_ENTRIES = ['apps/web/src/server.ts', 'packages/sync/src/index.ts', 'packages/sync/src/converter/index.ts'];
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];
const SHARED = 'vendor/moss/packages/shared/src';
const DESKTOP = 'vendor/moss/packages/desktop/src';

// Each rule names what it forbids; `file` tests a resolved repo path, `bare` a package specifier.
export const RULES = [
  { name: 'a node view (*.view.tsx)', file: (path) => /\.view\.tsx$/.test(path) },
  { name: 'CSS', file: (path) => /\.css$/.test(path) },
  { name: 'the @moss/shared barrel', file: (path) => path === `${SHARED}/index.ts` },
  { name: 'the Electron API (api/electron)', file: (path) => /(^|\/)api\/electron(\/index)?\.tsx?$/.test(path) },
  { name: 'react-dom', bare: (spec) => spec === 'react-dom' || spec.startsWith('react-dom/') },
  { name: 'jotai', bare: (spec) => spec === 'jotai' || spec.startsWith('jotai/') || spec === 'jotai-family' },
  { name: '@lexical/code (use @lexical/code-core)', bare: (spec) => spec === '@lexical/code' || spec.startsWith('@lexical/code/') },
];

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function withExtension(abs) {
  if (isFile(abs)) return abs;
  for (const ext of EXTENSIONS) if (isFile(abs + ext)) return abs + ext;
  for (const ext of EXTENSIONS) if (isFile(join(abs, `index${ext}`))) return join(abs, `index${ext}`);
  return null;
}

function workspacePackage(repo, spec) {
  const match = /^@moss-multi\/([^/]+)(\/.*)?$/.exec(spec);
  if (!match) return null;
  const dir = join(repo, 'packages', match[1]);
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return null;
  const exports = JSON.parse(readFileSync(manifest, 'utf8')).exports ?? {};
  const target = exports[`.${match[2] ?? ''}`];
  return typeof target === 'string' ? withExtension(join(dir, target)) : null;
}

// Moss's aliases (ARCHITECTURE §2): @moss/shared, @/ and @moss-desktop/.
export function resolveSpecifier(repo, fromFile, spec) {
  const clean = spec.replace(/\?.*$/, '');
  if (clean.startsWith('./') || clean.startsWith('../')) return { file: withExtension(resolve(dirname(fromFile), clean)) };
  if (clean === '@moss/shared') return { file: withExtension(join(repo, SHARED, 'index')) };
  if (clean.startsWith('@moss/shared/')) return { file: withExtension(join(repo, SHARED, clean.slice('@moss/shared/'.length))) };
  if (clean.startsWith('@/')) return { file: withExtension(join(repo, SHARED, clean.slice(2))) };
  if (clean.startsWith('@moss-desktop/')) return { file: withExtension(join(repo, DESKTOP, clean.slice('@moss-desktop/'.length))) };
  const workspace = workspacePackage(repo, clean);
  if (workspace) return { file: workspace };
  return { bare: clean };
}

// A class's `extends X` names X as a value, though its node is a type node; `implements` stays type-only.
const isClassExtends = (node) =>
  ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent) && node.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent.parent);

// Names used as values anywhere outside import declarations (by name; shadowing only adds edges).
function valueNames(sf) {
  const names = new Set();
  const visit = (node) => {
    if (isClassExtends(node)) return visit(node.expression);
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isName = parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent) && !ts.isExportSpecifier(parent);
      if (!isName && !(ts.isQualifiedName(parent) && parent.right === node)) names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

// Static imports a bundler keeps: [{ spec, line }].
export function runtimeImports(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /x$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let used = null;
  const imports = [];
  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause) {
        const locals = [];
        if (clause.name) locals.push(clause.name.text);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) locals.push(clause.namedBindings.name.text);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) locals.push(element.name.text);
        }
        used ??= valueNames(sf);
        if (!locals.some((name) => used.has(name))) continue;
      }
      imports.push({ spec: statement.moduleSpecifier.text, line: at(statement) });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
      const elements = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : null;
      if (elements && elements.every((e) => e.isTypeOnly)) continue;
      imports.push({ spec: statement.moduleSpecifier.text, line: at(statement) });
    }
  }
  return imports;
}

const toRepo = (repo, abs) => relative(repo, abs).split(sep).join(posix.sep);

export function checkBoundary({ repo = REPO, entries = DEFAULT_ENTRIES } = {}) {
  const violations = [];
  const unresolved = [];
  const parents = new Map();
  const queue = [];
  const roots = entries.map((entry) => resolve(repo, entry)).filter(isFile);
  const missing = entries.filter((entry) => !isFile(resolve(repo, entry)));
  for (const file of roots) {
    parents.set(file, null);
    queue.push(file);
  }
  const chain = (file) => {
    const steps = [];
    for (let at = file; at; at = parents.get(at)?.from) steps.unshift(toRepo(repo, at));
    return steps;
  };
  while (queue.length > 0) {
    const file = queue.shift();
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    for (const { spec, line } of runtimeImports(file, readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(repo, file, spec);
      const where = `${toRepo(repo, file)}:${line}`;
      if (target.bare !== undefined) {
        const rule = RULES.find((r) => r.bare?.(target.bare));
        if (rule) violations.push({ rule: rule.name, import: spec, at: where, chain: chain(file) });
        continue;
      }
      if (!target.file) {
        unresolved.push(`${where}: cannot resolve '${spec}'`);
        continue;
      }
      const path = toRepo(repo, target.file);
      const rule = RULES.find((r) => r.file?.(path));
      if (rule) {
        violations.push({ rule: rule.name, import: spec, at: where, chain: [...chain(file), path] });
        continue;
      }
      if (!parents.has(target.file)) {
        parents.set(target.file, { from: file });
        queue.push(target.file);
      }
    }
  }
  return { violations, unresolved, missing, files: parents.size, entries: roots.map((file) => toRepo(repo, file)) };
}

function main(argv) {
  const entries = argv.length > 0 ? argv : DEFAULT_ENTRIES;
  const { violations, unresolved, missing, files, entries: found } = checkBoundary({ entries });
  console.log(`bundle boundary: ${files} files reachable from ${found.join(', ') || '(no entries)'}`);
  for (const v of violations) console.log(`  FAIL ${v.at} imports ${v.rule} ('${v.import}')\n       via ${v.chain.join(' → ')}`);
  for (const u of unresolved) console.log(`  FAIL ${u}`);
  for (const entry of missing) console.log(`  FAIL entry ${entry} does not exist`);
  return violations.length > 0 || unresolved.length > 0 || missing.length > 0 || found.length === 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
