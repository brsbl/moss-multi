// Journey groups (A§20): the e2e job runs one shard per engine and group, each on its own stack. A journey
// belongs to the group whose id prefix matches the longest whole segment of its file name; plan.mjs refuses a
// journey in no group, so a new journey is never silently left out of CI. Dependency-free: plan.mjs and
// e2e/playwright.config.ts both import it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOURNEY_DIR = fileURLToPath(new URL('../../e2e/journeys', import.meta.url));

/** The whole-suite shard of a grep dispatch (no group filter). */
export const ALL = 'all';

/** @type {Record<string, string[]>} */
export const GROUPS = {
  // Chrome, auth, sharing and access.
  shell: ['j00-shell', 'j07', 'j08', 'j09', 'j10'],
  // A doc's content: import, persistence, co-editing, presence.
  editing: ['j00-import', 'j00-roundtrip', 'j00-persist', 'j01'],
  // Titles and properties. Split from editing so WebKit stays within 13 min (it reached 12.2 min at T1.9s).
  title: ['j02'],
  // A doc's connection: drops, stalls, limits, hibernation. Split from editing so WebKit stays within 13 min.
  session: ['j03', 'j04'],
  // Trash, folders, media, search, vaults, the demo note.
  workspace: ['j05', 'j06', 'j11', 'j12', 'j13', 'j14'],
  // Comments, suggestions, history, agents.
  meaning: ['j15', 'j16', 'j17', 'j18'],
};

/**
 * @param {string} file
 * @returns {string}
 */
const journeyId = (file) => (file.split('/').pop() ?? file).replace(/\.spec\.[cm]?[jt]s$/, '');

/**
 * The group of a journey file, or null when no prefix matches a whole segment of its id.
 * @param {string} file
 * @param {Record<string, string[]>} [groups]
 * @returns {string | null}
 */
export function groupOf(file, groups = GROUPS) {
  const id = journeyId(file);
  let best = null;
  let bestLength = -1;
  for (const [group, prefixes] of Object.entries(groups)) {
    for (const prefix of prefixes) {
      const whole = id === prefix || id.startsWith(`${prefix}-`);
      if (whole && prefix.length > bestLength) {
        best = group;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * @typedef {{ file: string, group: string | null, slow: boolean, legs?: number }} Journey
 */

/**
 * Leg declarations in a spec's source: `test(` or `test.only|fixme|fail|slow(` with a literal title. A leg declared in
 * a loop counts once, so the count tracks added declarations, not runtime legs.
 * @param {string} text
 * @returns {number}
 */
export const countLegs = (text) => (text.match(/^\s*test(?:\.(?:only|fixme|fail|slow))?\(\s*[`'"]/gm) ?? []).length;

/**
 * The journey spec files in `dir`, each with its group, whether any leg is tagged @slow, and its leg declarations.
 * @param {string} [dir]
 * @returns {Journey[]}
 */
export function readJourneys(dir = JOURNEY_DIR) {
  return readdirSync(dir)
    .filter((file) => /\.spec\.[cm]?[jt]s$/.test(file) && statSync(join(dir, file)).isFile())
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      return { file, group: groupOf(file), slow: /@slow\b/.test(text), legs: countLegs(text) };
    });
}

// Shard budget (T0.9d): a ready-PR shard's p95 must stay within 9 of its 13 minutes (30% headroom). The recorded
// minutes (scripts/ci/journey-minutes.json, written by scripts/ci/durations.mjs from recent full lanes) hold each
// journey file's p95 per engine, the shard's fixed cost (setup, stack boot, selftests) and a per-leg rate for files not
// measured yet. A group's estimate is the setup plus its files' minutes, each scaled up by legs declared since it was
// measured; `plan.mjs budget` (a checks step) fails CI when any group's estimate exceeds the budget.
export const SHARD_BUDGET_MINUTES = 9;
export const ENGINES = ['chromium', 'webkit'];
export const MINUTES_FILE = fileURLToPath(new URL('./journey-minutes.json', import.meta.url));

/**
 * @typedef {{ legs: number, chromium: number, webkit: number }} FileMinutes
 * @typedef {{ setup: Record<string, number>, perLeg: Record<string, number>, journeys: Record<string, FileMinutes> }} Minutes
 */

/** @returns {Minutes} */
export const readMinutes = (path = MINUTES_FILE) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * One journey file's estimated minutes in `engine`: its recorded p95 scaled by legs declared since, or the per-leg
 * rate when it has no record.
 * @param {Journey} journey
 * @param {string} engine
 * @param {Minutes} minutes
 */
export function fileMinutes(journey, engine, minutes) {
  const recorded = minutes.journeys[journey.file];
  if (!recorded) return minutes.perLeg[engine] * Math.max(1, journey.legs ?? 1);
  const growth = recorded.legs > 0 && journey.legs ? Math.max(1, journey.legs / recorded.legs) : 1;
  return recorded[engine] * growth;
}

/**
 * Each present group's estimated shard minutes per engine.
 * @param {Journey[]} journeys
 * @param {Minutes} minutes
 * @returns {{ group: string, engine: string, minutes: number, files: string[] }[]}
 */
export function shardEstimates(journeys, minutes) {
  const shards = [];
  for (const group of Object.keys(GROUPS)) {
    const files = journeys.filter((journey) => journey.group === group);
    if (files.length === 0) continue;
    for (const engine of ENGINES) {
      const total = files.reduce((sum, journey) => sum + fileMinutes(journey, engine, minutes), minutes.setup[engine]);
      shards.push({ group, engine, minutes: Math.round(total * 100) / 100, files: files.map((journey) => journey.file) });
    }
  }
  return shards;
}

/**
 * Why the estimates do not fit the budget; empty when every group fits.
 * @param {Journey[]} journeys
 * @param {Minutes} minutes
 * @param {number} [budget]
 * @returns {string[]}
 */
export function budgetProblems(journeys, minutes, budget = SHARD_BUDGET_MINUTES) {
  return shardEstimates(journeys, minutes)
    .filter((shard) => shard.minutes > budget)
    .map((shard) => `${shard.engine}/${shard.group} is estimated at ${shard.minutes} min, over its ${budget}: split ${shard.files.join(', ')} across groups in scripts/ci/journeys.mjs`);
}

/**
 * Playwright `testMatch` for one group's shard: exactly its journey files, so no file can match two shards.
 * @param {string} group
 * @param {string} [dir]
 * @returns {RegExp[]}
 */
export function journeyMatch(group, dir = JOURNEY_DIR) {
  if (!Object.hasOwn(GROUPS, group)) throw new Error(`unknown journey group "${group}" (scripts/ci/journeys.mjs has ${Object.keys(GROUPS).join(', ')})`);
  const files = readJourneys(dir).filter((journey) => journey.group === group).map((journey) => journey.file);
  if (files.length === 0) throw new Error(`journey group "${group}" has no journeys in ${dir}`);
  return files.map((file) => new RegExp(`(?:^|[\\\\/])${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}
