#!/usr/bin/env node
// Trace check: every milestone a BUILDPLAN trace row lists needs a tagged leg once the gate reaches it: the first
// milestone a plain @p:<id> (or @p:<id>@<k>), each later one @p:<id>@<k>. Every tag must name a row and one of its
// milestones. Legs are *.spec.* and *.test.* files; tags inside comments do not count.
// Usage: node scripts/ci/trace.mjs [--milestone <k>] [--plan BUILDPLAN.md] [--root <dir>]...
// The gate defaults to $TRACE_MILESTONE (from plan.mjs); with no gate it reports without failing on missing legs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_ROOTS = ['e2e', 'apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'fixtures', 'vendor', '.git', '.wrangler', 'test-results']);
const LEG_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const TAG = /@p:([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?:@\d+)?)/g;

function parseMilestones(cell) {
  const milestones = [];
  for (const part of cell.split(',')) {
    const range = /^\s*(\d+)\s*(?:[–-]\s*(\d+)\s*)?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (to < from) return null;
    for (let m = from; m <= to; m += 1) milestones.push(m);
  }
  return milestones;
}

// Rows of the first table under "## Trace": the first cell is the id, the last is the milestone list.
export function parseTrace(markdown) {
  const rows = [];
  const problems = [];
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^## Trace\s*$/.test(line));
  if (start >= 0) {
    let inTable = false;
    for (const line of lines.slice(start + 1)) {
      if (/^## /.test(line)) break;
      if (!line.startsWith('|')) {
        if (inTable) break;
        continue;
      }
      inTable = true;
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (cells.length < 2 || cells[0] === 'Id' || /^-+$/.test(cells[0])) continue;
      const [id] = cells;
      const milestones = parseMilestones(cells.at(-1));
      if (!milestones) {
        problems.push(`${id}: unreadable milestone "${cells.at(-1)}"`);
        continue;
      }
      rows.push({ id, milestones, due: Math.min(...milestones) });
    }
  }
  if (rows.length === 0 && problems.length === 0) problems.push('no trace rows found under "## Trace"');
  return { rows, problems };
}

/** The source with its // and /* */ comments blanked; strings and template literals are kept. */
export function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      out += char;
      if (char === '\\') out += text[(i += 1)] ?? '';
      else if (char === quote || (char === '\n' && quote !== '`')) quote = null;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out += text.slice(i, end < 0 ? text.length : end + 2).replace(/[^\n]/g, ' ');
      i = end < 0 ? text.length : end + 1;
    } else {
      if (char === "'" || char === '"' || char === '`') quote = char;
      out += char;
    }
  }
  return out;
}

/** Tag -> files carrying it, keyed `id` for a plain tag and `id@k` for a milestone tag. */
export function collectTags(files) {
  const tags = new Map();
  for (const { path, text } of files) {
    for (const [, id] of stripComments(text).matchAll(TAG)) {
      if (!tags.has(id)) tags.set(id, []);
      if (!tags.get(id).includes(path)) tags.get(id).push(path);
    }
  }
  return tags;
}

export function listLegFiles(roots) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (LEG_FILE.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const root of roots) walk(root);
  return files.sort();
}

export function checkTrace({ rows, tags, milestone }) {
  const problems = [];
  const ids = new Set(rows.map((row) => row.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (milestone !== null) {
    for (const row of rows) {
      for (const m of row.milestones.filter((k) => k <= milestone)) {
        if (tags.has(`${row.id}@${m}`) || (m === row.due && tags.has(row.id))) continue;
        problems.push(m === row.due ? `${row.id} (due M${m}) has no tagged leg` : `${row.id} (due M${m}) has no leg tagged @p:${row.id}@${m}`);
      }
    }
  }
  for (const [tag, paths] of tags) {
    const [id, at] = tag.split('@');
    if (!ids.has(id)) problems.push(`${tag} is tagged in ${paths.join(', ')} but is not a trace row`);
    else if (at !== undefined && !byId.get(id).milestones.includes(Number(at))) {
      problems.push(`${tag} is tagged in ${paths.join(', ')} but ${id} is not due at M${at}`);
    }
  }
  return { problems };
}

function parseArgs(argv) {
  const args = { plan: join(REPO, 'BUILDPLAN.md'), roots: [], milestone: process.env.TRACE_MILESTONE ?? '' };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--plan') args.plan = value;
    else if (argv[i] === '--root') args.roots.push(value);
    else if (argv[i] === '--milestone') args.milestone = value;
    else throw new Error(`unknown argument ${argv[i]}`);
    i += 1;
  }
  if (args.roots.length === 0) {
    args.roots = DEFAULT_ROOTS.map((root) => join(REPO, root)).filter((root) => {
      try {
        return statSync(root).isDirectory();
      } catch {
        return false;
      }
    });
  }
  if (args.milestone !== '' && !/^\d+$/.test(args.milestone)) throw new Error(`milestone must be a number, got "${args.milestone}"`);
  args.milestone = args.milestone === '' ? null : Number(args.milestone);
  return args;
}

function main(argv) {
  const { plan, roots, milestone } = parseArgs(argv);
  const parsed = parseTrace(readFileSync(plan, 'utf8'));
  const files = listLegFiles(roots).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  const tags = collectTags(files);
  const { problems } = checkTrace({ rows: parsed.rows, tags, milestone });
  const tagged = parsed.rows.filter((row) => row.milestones.some((m) => tags.has(`${row.id}@${m}`)) || tags.has(row.id)).length;
  const gate = milestone === null ? 'no milestone gate (report only)' : `gate M${milestone}`;
  console.log(`trace: ${parsed.rows.length} rows, ${tagged} tagged, ${files.length} leg files; ${gate}`);
  const all = [...parsed.problems, ...problems];
  if (all.length > 0) {
    console.log(all.map((problem) => `  FAIL ${problem}`).join('\n'));
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
