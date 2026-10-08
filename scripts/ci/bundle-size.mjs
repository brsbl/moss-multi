#!/usr/bin/env node
// Bundle sizes for a built package directory (packages/editor/dist, packages/viewer/dist): every script's bytes and
// gzip, and the entry's static import closure, the bytes a page must fetch and evaluate before the first mount.
//   node scripts/ci/bundle-size.mjs <dist> <entry.js> [--json]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const STATIC_IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(code, pattern) {
  const found = new Set();
  for (const match of code.matchAll(pattern)) if (match[1].startsWith('.')) found.add(match[1]);
  return [...found];
}

/** Every script in `dist` with its size, gzip size, static and dynamic imports (paths relative to dist). */
export function bundleSizes(dist, entry) {
  const scripts = readdirSync(dist, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.js'))
    .sort();
  const files = {};
  for (const file of scripts) {
    const bytes = readFileSync(join(dist, file));
    const code = bytes.toString('utf8');
    const resolveFrom = (specifier) => relative(dist, normalize(join(dist, dirname(file), specifier)));
    files[file] = {
      bytes: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      imports: specifiers(code, STATIC_IMPORT).map(resolveFrom),
      dynamic: specifiers(code, DYNAMIC_IMPORT).map(resolveFrom),
    };
  }
  const closure = [];
  const visit = (file) => {
    if (closure.includes(file) || !files[file]) return;
    closure.push(file);
    for (const next of files[file].imports) visit(next);
  };
  visit(entry);
  const sum = (key) => closure.reduce((total, file) => total + files[file][key], 0);
  return {
    entry,
    critical: { files: closure, bytes: sum('bytes'), gzip: sum('gzip') },
    total: {
      bytes: Object.values(files).reduce((total, file) => total + file.bytes, 0),
      gzip: Object.values(files).reduce((total, file) => total + file.gzip, 0),
    },
    files,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dist, entry, flag] = process.argv.slice(2);
  if (!dist || !entry) throw new Error('usage: bundle-size.mjs <dist> <entry.js> [--json]');
  const sizes = bundleSizes(dist, entry);
  if (flag === '--json') {
    console.log(JSON.stringify(sizes, null, 2));
  } else {
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    console.log(`entry ${entry}: critical path ${sizes.critical.files.length} file(s), ${kb(sizes.critical.bytes)}, ${kb(sizes.critical.gzip)} gzip`);
    console.log(`all scripts: ${kb(sizes.total.bytes)}, ${kb(sizes.total.gzip)} gzip`);
    for (const [file, info] of Object.entries(sizes.files).sort((a, b) => b[1].bytes - a[1].bytes)) {
      const tag = sizes.critical.files.includes(file) ? 'critical' : 'lazy';
      console.log(`  ${tag.padEnd(8)} ${kb(info.bytes).padStart(11)} ${kb(info.gzip).padStart(11)} gzip  ${file}`);
    }
  }
}
