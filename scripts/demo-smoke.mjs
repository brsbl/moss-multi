#!/usr/bin/env node
// The demo generator's CI smoke (T8.B2): against an isolated stack, first the note step resumed after each
// interruption (after the title, after half the paste, after the first media file), each finished note rendering what
// an uninterrupted one does and a rerun changing nothing; then buildDemo twice, the rerun adding nothing. buildDemo
// itself checks the notes, media, comments, reactions, suggestions, versions and the view link.
//   node scripts/demo-smoke.mjs --run-id RUN [--driver puppeteer --chrome PATH] [--skip-agent]
import { pathToFileURL } from 'node:url';
import { censusDiff, familyProblems } from '../e2e/qa/demo.js';
import { buildDemo, NOTES, noteParams, withDemoRun } from './demo.mjs';
import { parseArgs } from './qa.mjs';

export const RESUME_FOLDER = 'Resume check';
export const STOPS = ['title', 'paste', 'media'];

/** What keeps one resumed note from matching the uninterrupted one: [] when it matches and a rerun changed nothing. */
export function resumeProblems({ stop, first, resumed, again, reference, census, after }) {
  const problems = [];
  if (first.stopped !== stop) problems.push(`the run stopped at ${first.stopped ?? 'the end'}, not after the ${stop}`);
  if (resumed.id !== first.id || again.id !== first.id) problems.push('the rerun made another note instead of finishing the first');
  if (resumed.created || !resumed.changed.length) problems.push('the rerun finished nothing');
  if (again.changed.length) problems.push(`a rerun over the finished note changed ${again.changed.join(', ')}`);
  problems.push(...censusDiff(reference, census).map((d) => `finished note differs from the uninterrupted one: ${d}`));
  problems.push(...censusDiff(census, after).map((d) => `the rerun changed the body: ${d}`));
  return problems;
}

export async function resumeLegs(opts, deps = {}) {
  const every = NOTES.find((note) => note.key === 'every');
  return withDemoRun(opts, deps, async ({ step, log }) => {
    await step('folder', { folderName: RESUME_FOLDER });
    const made = await step('note', noteParams(every, RESUME_FOLDER, 'Uninterrupted'));
    const { census: reference } = await step('census', { docId: made.id });
    const problems = familyProblems(reference).map((p) => `the uninterrupted note: ${p}`);
    if (reference.image !== 1 || reference.video !== 1) problems.push(`the uninterrupted note holds ${reference.image} images and ${reference.video} videos, not one of each`);
    for (const stop of STOPS) {
      const params = noteParams(every, RESUME_FOLDER, `Stopped after the ${stop}`);
      const first = await step('note', { ...params, stopAfter: stop });
      const resumed = await step('note', params);
      const { census } = await step('census', { docId: resumed.id });
      const again = await step('note', params);
      const { census: after } = await step('census', { docId: again.id });
      const found = resumeProblems({ stop, first, resumed, again, reference, census, after });
      log(`stopped after the ${stop}: ${found.length ? found.join('; ') : `finished (${resumed.changed.join(', ')}), and a rerun changed nothing`}`);
      problems.push(...found.map((p) => `after the ${stop}: ${p}`));
    }
    return problems;
  });
}

async function main(argv) {
  const { opts } = parseArgs(['smoke', ...argv]);
  const problems = [];
  const leg = async (name, run) => {
    try {
      problems.push(...(await run()).map((p) => `${name}: ${p}`));
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  };
  await leg('resume', () => resumeLegs(opts));
  let first = null;
  await leg('first run', async () => {
    first = await buildDemo(opts);
    return first.changes.length ? [] : ['a first run on a fresh stack added nothing'];
  });
  await leg('rerun', async () => {
    const again = await buildDemo(opts);
    return [
      ...again.changes.map((change) => `added ${change}`),
      ...(first ? censusDiff(first.census, again.census).map((d) => `the every-node note changed: ${d}`) : []),
    ];
  });
  for (const problem of problems) console.error(`::error::${problem}`);
  console.log(problems.length ? `demo smoke: ${problems.length} problems` : 'demo smoke: resumed notes, a complete first run and a duplicate-free rerun');
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
