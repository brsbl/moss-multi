#!/usr/bin/env node
// Which journey legs the staging suite leaves out (A§21, T8.2). Staging has no test hooks and no stack this run owns,
// so a leg that probes or resets a DO through a hook, or pauses or restarts the stack, is tagged @local-only, with a
// `// local-only: <reason>` line above it. The staging projects in e2e/playwright.config.ts drop those legs.
//   node scripts/deploy/local-only.mjs        lists each @local-only leg and fails on an untagged or unexplained one
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { JOURNEY_DIR } from '../ci/journeys.mjs';

export const LOCAL_ONLY = /@local-only\b/;
const REASON = /^\/\/\s*local-only:\s*\S/;

/** What only a local stack offers: the loopback hooks, the stack levers, and induce()'s default hook probe. */
const NEEDS = [
  { what: 'a test hook or a stack lever', test: (body) => /\bstack\.(?:docInstance|resetDoc|pause|resume|restart)\(/.test(body) },
  { what: "a restart or reset lever", test: (body) => /\blever:\s*'(?:restart|reset)'/.test(body) },
  { what: "induce() with the hook probe", test: (body) => /\binduce\(/.test(body) && !/\bprobe:/.test(body) },
];

/**
 * Every `test(...)` leg in a spec's source: its title as written (a template keeps its `${}` parts), the leg's text,
 * and the comment lines directly above it.
 * @param {string} text
 * @param {string} [file]
 */
export function legsOf(text, file = 'spec.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {{ title: string, line: number, body: string, comments: string[] }[]} */
  const legs = [];
  const visit = (node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const callee = call.expression.getText(source);
      if ((callee === 'test' || callee === 'test.only') && call.arguments.length >= 2) {
        const comments = (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []).map((range) => text.slice(range.pos, range.end).trim());
        legs.push({
          title: call.arguments[0].getText(source),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          body: call.arguments.slice(1).map((arg) => arg.getText(source)).join('\n'),
          comments,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return legs;
}

/**
 * Problems with a spec's @local-only tags: a leg that needs a local stack but is not tagged, and a tagged leg with
 * no `// local-only: <reason>` line above it.
 * @param {string} text
 * @param {string} [file]
 */
export function localOnlyProblems(text, file = 'spec.ts') {
  const problems = [];
  for (const leg of legsOf(text, file)) {
    const tagged = LOCAL_ONLY.test(leg.title);
    if (!tagged) {
      for (const need of NEEDS) if (need.test(leg.body)) problems.push(`${file}:${leg.line} uses ${need.what} but is not tagged @local-only`);
    } else if (!leg.comments.some((comment) => REASON.test(comment))) {
      problems.push(`${file}:${leg.line} is @local-only with no "// local-only: <reason>" line above it`);
    }
  }
  return problems;
}

/** Each journey spec's @local-only legs and problems. */
export function scanJourneys(dir = JOURNEY_DIR) {
  const files = readdirSync(dir).filter((name) => /\.spec\.ts$/.test(name)).sort();
  return files.map((name) => {
    const text = readFileSync(join(dir, name), 'utf8');
    const legs = legsOf(text, name);
    return {
      file: name,
      legs: legs.length,
      localOnly: legs.filter((leg) => LOCAL_ONLY.test(leg.title)).map((leg) => ({ line: leg.line, reason: leg.comments.find((c) => REASON.test(c)) ?? null })),
      problems: localOnlyProblems(text, name),
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scan = scanJourneys();
  for (const spec of scan) for (const leg of spec.localOnly) console.log(`${spec.file}:${leg.line} ${leg.reason ?? '(no reason)'}`);
  const problems = scan.flatMap((spec) => spec.problems);
  for (const problem of problems) console.error(`::error::${problem}`);
  const total = scan.reduce((n, spec) => n + spec.legs, 0);
  const local = scan.reduce((n, spec) => n + spec.localOnly.length, 0);
  console.log(`${local} of ${total} journey legs are @local-only`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
