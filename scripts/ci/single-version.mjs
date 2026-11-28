#!/usr/bin/env node
// Fails unless lexical, every @lexical/* and yjs each resolve to one version that matches its pnpm override.
// Usage: node scripts/ci/single-version.mjs [pnpm-lock.yaml]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED_OVERRIDES = ['lexical', 'yjs'];
const isLexical = (name) => name === 'lexical' || name.startsWith('@lexical/');
const isTracked = (name) => isLexical(name) || name === 'yjs';
const unquote = (text) => text.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

// Reads the top-level overrides and packages sections of a v9 pnpm lockfile.
export function parseLockfile(text) {
  const lock = { version: '', overrides: new Map(), packages: new Map() };
  let section = '';
  for (const line of text.split('\n')) {
    const top = /^([A-Za-z]\w*):\s*((?:\S.*)?)$/.exec(line);
    if (top) {
      section = top[1];
      if (section === 'lockfileVersion') lock.version = unquote(top[2]);
      continue;
    }
    if (section === 'overrides') {
      const entry = /^ {2}('[^']+'|"[^"]+"|[^\s:]+):\s*(\S.*|[^\S\n\r\u2028\u2029])$/.exec(line);
      if (entry) lock.overrides.set(unquote(entry[1]), unquote(entry[2]));
    } else if (section === 'packages') {
      const entry = /^ {2}'?((?:@[^/\s']+\/)?[^@\s'/]+)@([^(\s':]+)/.exec(line);
      if (!entry) continue;
      const [, name, version] = entry;
      if (!lock.packages.has(name)) lock.packages.set(name, new Set());
      lock.packages.get(name).add(version);
    }
  }
  return lock;
}

export function checkSingleVersions(text) {
  const lock = parseLockfile(text);
  if (!lock.version.startsWith('9.')) {
    return { problems: [`unsupported lockfileVersion ${lock.version || '(missing)'}`], resolved: new Map() };
  }
  const problems = [];
  for (const name of REQUIRED_OVERRIDES) {
    if (!lock.overrides.has(name)) problems.push(`pnpm override missing for ${name}`);
  }
  const resolved = new Map();
  const lexicalVersions = new Set();
  for (const [name, versionSet] of [...lock.packages].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isTracked(name)) continue;
    const versions = [...versionSet].sort();
    resolved.set(name, versions);
    if (versions.length > 1) problems.push(`${name} resolves to ${versions.length} versions: ${versions.join(', ')}`);
    const pin = lock.overrides.get(name);
    if (pin === undefined) {
      if (isLexical(name)) problems.push(`${name} has no pnpm override`);
    } else {
      for (const version of versions) {
        if (version !== pin) problems.push(`${name} resolves to ${version} but is overridden to ${pin}`);
      }
    }
    if (isLexical(name)) versions.forEach((version) => lexicalVersions.add(version));
  }
  if (lexicalVersions.size > 1) problems.push(`Lexical packages span versions ${[...lexicalVersions].sort().join(', ')}`);
  return { problems, resolved };
}

function main(argv) {
  const path = argv[0] ?? 'pnpm-lock.yaml';
  const { problems, resolved } = checkSingleVersions(readFileSync(path, 'utf8'));
  const summary = [...resolved].map(([name, versions]) => `${name}@${versions.join('|')}`).join(' ') || 'none installed yet';
  console.log(`single-version (${path}): ${summary}`);
  if (problems.length > 0) {
    console.log(problems.map((problem) => `  FAIL ${problem}`).join('\n'));
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
