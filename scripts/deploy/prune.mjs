#!/usr/bin/env node
// The staging prune (A§21, T8.2): before a suite=full deploy, deploy-staging.yml deletes the per-run principals earlier
// suites signed up or seeded, older than PRUNE_AGE_MS, at most PRUNE_CAP a run, so a full suite stays under the growth
// cap (growth.mjs). It selects by a staging run's provenance in the email, never a bare `mm-` prefix: a staging run's
// token (`mm-staging-<run id>-...`, deploy-staging's RUN_ID) or a seed token (`mm-s<run id>-<attempt>-<slots>-<k>`).
// Never the canary pool (`canary-*`), the demo accounts (`demo-*`) or any other account, nor their docs. The SQL
// selects with PER_RUN's exact SQLite form; a returned row that still fails PER_RUN is skipped and counted, never
// fatal. It counts first (the dry run, printed), then deletes their grants, share links, invites and user rows; a user row's docs, folders, sessions, accounts and agents cascade. A DocDO's own
// storage is not reclaimed; growth.mjs counts the Durable Objects themselves.
//   node scripts/deploy/prune.mjs count-sql | select-sql      (the SQL for wrangler d1 execute --json)
//   node scripts/deploy/prune.mjs plan COUNT.json SELECT.json OUT.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The most principals one run deletes. */
export const PRUNE_CAP = 6_000;
/** Only principals older than this: none of a run still going (deploys are serialized; this is the margin). */
export const PRUNE_AGE_MS = 2 * 60 * 60 * 1000;
const BATCH = 100;
/**
 * A staging run's principal: e2e/lib/principals.ts newPrincipal under a staging RUN_ID (`mm-staging-<run id>-...`), or
 * scripts/deploy/seed.mjs seedEmail (`mm-s<run id>-<attempt>-<slot>-<k>`). Case-sensitive, ASCII only. PER_RUN_SQL is
 * the same predicate in SQLite, so the selection returns exactly the rows the plan may delete (deploy.test.mjs checks
 * both on one table).
 */
export const PER_RUN = /^(?:mm-staging-[0-9]{1,20}-[a-z0-9][a-z0-9-]{0,199}|mm-s[0-9]{1,20}-[0-9]{1,4}-[cw][1-8]-[0-9]{1,4})@example\.invalid$/;

const DOMAIN = '@example.invalid';
/** `e` is one or more digits and nothing else, at most `max`. */
const digits = (e, max) => `(length(${e}) BETWEEN 1 AND ${max} AND ${e} NOT GLOB '*[^0-9]*')`;
/** `e` up to its first `-`, and after it. */
const head = (e) => `substr(${e}, 1, instr(${e}, '-') - 1)`;
const tail = (e) => `substr(${e}, instr(${e}, '-') + 1)`;
/** The local part; GLOB is case-sensitive, `_` and `%` are literal in it, and `[^...]` names any other character. */
const LOCAL = `substr(email, 1, length(email) - ${DOMAIN.length})`;
const STAGING = (() => {
  const rest = `substr(${LOCAL}, 12)`;
  const token = tail(rest);
  return `(${LOCAL} GLOB 'mm-staging-[0-9]*' AND ${rest} NOT GLOB '*[^a-z0-9-]*' AND ${digits(head(rest), 20)} ` +
    `AND length(${token}) BETWEEN 1 AND 200 AND ${token} GLOB '[a-z0-9]*')`;
})();
const SEEDED = (() => {
  const rest = `substr(${LOCAL}, 5)`;
  const attempt = tail(rest);
  const slot = tail(attempt);
  return `(${LOCAL} GLOB 'mm-s[0-9]*' AND ${rest} NOT GLOB '*[^0-9cw-]*' AND ${digits(head(rest), 20)} AND ${digits(head(attempt), 4)} ` +
    `AND ${slot} GLOB '[cw][1-8]-*' AND ${digits(`substr(${slot}, 4)`, 4)})`;
})();
/** PER_RUN in SQLite, on a `user` row's `email`. */
export const PER_RUN_SQL = `(email GLOB '*${DOMAIN}' AND (${STAGING} OR ${SEEDED}))`;
/** better-auth's ids: letters, digits, `-` and `_`. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The count (the dry run) and the selection, for principals created before `now - PRUNE_AGE_MS`.
 * @param {number} now
 */
export function pruneSql(now) {
  const cutoff = Math.floor(now - PRUNE_AGE_MS);
  const where = `${PER_RUN_SQL} AND created_at < ${cutoff}`;
  return {
    count: `SELECT (SELECT count(*) FROM user WHERE ${where}) AS users, (SELECT count(*) FROM docs WHERE owner_user_id IN (SELECT id FROM user WHERE ${where})) AS docs`,
    // By (created_at, id), so a page is the same on every read; one more than the cap, so the plan can say more remain.
    select: `SELECT id, email FROM user WHERE ${where} ORDER BY created_at, id LIMIT ${PRUNE_CAP + 1}`,
  };
}

/** @param {string} text wrangler d1 execute --json output */
const rowsOf = (text) => {
  const [first] = JSON.parse(text);
  if (!Array.isArray(first?.results)) throw new Error('no rows in the prune query output');
  return first.results;
};

/**
 * The dry run's summary and the delete SQL for at most PRUNE_CAP of the selected per-run principals. A row that is not
 * a per-run principal with a plain id is skipped and counted, never deleted and never a reason to stop the deploy:
 * sign-up is open on staging.
 * @param {string} countText
 * @param {string} selectText
 */
export function prunePlan(countText, selectText) {
  const [count] = rowsOf(countText);
  const { users, docs } = count ?? {};
  if (!Number.isInteger(users) || !Number.isInteger(docs)) throw new Error('no counts in the prune count output');
  const rows = /** @type {{ id: unknown, email: unknown }[]} */ (rowsOf(selectText));
  const perRun = rows.filter((row) => typeof row.email === 'string' && PER_RUN.test(row.email) && typeof row.id === 'string' && ID.test(row.id));
  const skipped = rows.length - perRun.length;
  const ids = perRun.slice(0, PRUNE_CAP).map((row) => /** @type {string} */ (row.id));
  const statements = [];
  for (let at = 0; at < ids.length; at += BATCH) {
    const list = ids.slice(at, at + BATCH).map((id) => `'${id}'`).join(', ');
    const agents = `SELECT id FROM agents WHERE owner_user_id IN (${list})`;
    statements.push(
      `DELETE FROM doc_members WHERE principal_id IN (${list}) OR principal_id IN (${agents});`,
      `DELETE FROM folder_members WHERE principal_id IN (${list}) OR principal_id IN (${agents});`,
      `DELETE FROM share_links WHERE created_by IN (${list});`,
      `DELETE FROM invites WHERE invited_by IN (${list});`,
      `DELETE FROM user WHERE id IN (${list});`,
      // The docs and folders that cascaded bumped their owner's epoch row; the owner is gone.
      `DELETE FROM access_epochs WHERE owner_user_id IN (${list});`,
    );
  }
  const summary = `staging holds ${users} selected principals older than ${PRUNE_AGE_MS / 3_600_000} h owning ${docs} docs; ` +
    `this run deletes ${ids.length} (cap ${PRUNE_CAP}) and skips ${skipped} that are not per-run principals with a plain id` +
    `${users > ids.length + skipped ? `, ${users - ids.length - skipped} remain for later runs` : ''}`;
  return { summary, ids, sql: statements.length > 0 ? `${statements.join('\n')}\n` : '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, countFile, selectFile, out] = process.argv.slice(2);
  try {
    if (mode === 'count-sql' || mode === 'select-sql') {
      const sql = pruneSql(Date.now());
      console.log(mode === 'count-sql' ? sql.count : sql.select);
    } else if (mode === 'plan' && countFile && selectFile && out) {
      const plan = prunePlan(readFileSync(countFile, 'utf8'), readFileSync(selectFile, 'utf8'));
      console.log(plan.summary);
      writeFileSync(out, plan.sql);
    } else {
      throw new Error('usage: prune.mjs count-sql | select-sql | plan COUNT.json SELECT.json OUT.sql');
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
