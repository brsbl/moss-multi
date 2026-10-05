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
  // Trash, folders, media, search, vaults, the demo note, tab/print/download (T3.7's export journey).
  workspace: ['j05', 'j06', 'j11', 'j12', 'j13', 'j14', 'export'],
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
 * @typedef {{ file: string, group: string | null, slow: boolean }} Journey
 */

/**
 * The journey spec files in `dir`, each with its group and whether any leg is tagged @slow.
 * @param {string} [dir]
 * @returns {Journey[]}
 */
export function readJourneys(dir = JOURNEY_DIR) {
  return readdirSync(dir)
    .filter((file) => /\.spec\.[cm]?[jt]s$/.test(file) && statSync(join(dir, file)).isFile())
    .sort()
    .map((file) => ({ file, group: groupOf(file), slow: /@slow\b/.test(readFileSync(join(dir, file), 'utf8')) }));
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
