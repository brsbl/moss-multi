#!/usr/bin/env node
// The staging prune (A§21, T8.2): before a suite=full deploy, deploy-staging.yml deletes the per-run principals earlier
// suites signed up or seeded (`mm-*@example.invalid`, older than PRUNE_AGE_MS), at most PRUNE_CAP a run, so a full
// suite stays under the growth cap (growth.mjs). Never the canary pool (`canary-*`) nor the demo accounts (`demo-*`,
// and demo.mjs refuses an `mm` prefix) and their docs. It counts first (the dry run, printed), then deletes their grants, share links, invites and user rows; a
// user row's docs, folders, sessions, accounts and agents cascade. A DocDO's own storage is not reclaimed.
//   node scripts/deploy/prune.mjs count-sql | select-sql      (the SQL for wrangler d1 execute --json)
//   node scripts/deploy/prune.mjs plan COUNT.json SELECT.json OUT.sql
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The most principals one run deletes. */
export const PRUNE_CAP = 6_000;
/** Only principals older than this: none of a run still going (deploys are serialized; this is the margin). */
export const PRUNE_AGE_MS = 2 * 60 * 60 * 1000;
const BATCH = 100;
/** A per-run principal (e2e/lib/principals.ts newPrincipal, scripts/deploy/seed.mjs seedEmail). */
const PER_RUN = /^mm-[a-z0-9-]{1,200}@example\.invalid$/;
/** better-auth's ids: letters, digits, `-` and `_`. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The count (the dry run) and the selection, for principals created before `now - PRUNE_AGE_MS`.
 * @param {number} now
 */
export function pruneSql(now) {
  const cutoff = Math.floor(now - PRUNE_AGE_MS);
  const where = `email LIKE 'mm-%@example.invalid' AND created_at < ${cutoff}`;
  return {
    count: `SELECT (SELECT count(*) FROM user WHERE ${where}) AS users, (SELECT count(*) FROM docs WHERE owner_user_id IN (SELECT id FROM user WHERE ${where})) AS docs`,
    // One more than the cap, so the plan can say more remain.
    select: `SELECT id, email FROM user WHERE ${where} ORDER BY created_at LIMIT ${PRUNE_CAP + 1}`,
  };
}

/** @param {string} text wrangler d1 execute --json output */
const rowsOf = (text) => {
  const [first] = JSON.parse(text);
  if (!Array.isArray(first?.results)) throw new Error('no rows in the prune query output');
  return first.results;
};

/**
 * The dry run's summary and the delete SQL for at most PRUNE_CAP of the selected principals; refuses any row that is
 * not a per-run principal.
 * @param {string} countText
 * @param {string} selectText
 */
export function prunePlan(countText, selectText) {
  const [count] = rowsOf(countText);
  const { users, docs } = count ?? {};
  if (!Number.isInteger(users) || !Number.isInteger(docs)) throw new Error('no counts in the prune count output');
  const rows = /** @type {{ id: unknown, email: unknown }[]} */ (rowsOf(selectText));
  for (const row of rows) {
    if (typeof row.email !== 'string' || !PER_RUN.test(row.email) || typeof row.id !== 'string' || !ID.test(row.id)) {
      throw new Error('refusing to prune: a selected row is not a per-run @example.invalid principal with a plain id');
    }
  }
  const ids = rows.slice(0, PRUNE_CAP).map((row) => /** @type {string} */ (row.id));
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
  const summary = `staging holds ${users} per-run principals older than ${PRUNE_AGE_MS / 3_600_000} h owning ${docs} docs; ` +
    `this run deletes ${ids.length} (cap ${PRUNE_CAP})${users > ids.length ? `, ${users - ids.length} remain for later runs` : ''}`;
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
