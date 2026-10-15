#!/usr/bin/env node
// The staging suite's per-run principals (A§21, T8.2). Staging allows 30 sign-ups a day per client address (auth.ts),
// far fewer than a full suite's fresh accounts, so a suite=full deploy writes this run's accounts into D1 as a sign-up
// would (a user row and a credential account with better-auth's password hash), and each suite shard signs in to its
// own slots: `mm-<token>-<slots>-<k>@example.invalid`, which the prune takes on a later run. The one password per run
// derives from the pool secret; only its hash reaches D1 and only the derived password, masked, reaches the shards.
//   node scripts/deploy/seed.mjs sql OUT.sql --token TOKEN        (CANARY_POOL_SECRET in the environment)
//   node scripts/deploy/seed.mjs password --token TOKEN           (prints the password, for ::add-mask:: first)
//   node scripts/deploy/seed.mjs token RUN_ID RUN_ATTEMPT
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Accounts per shard: about three times the most one shard signed up on staging. */
export const SEED_PER_SHARD = 300;
/** One slot set per suite shard: `<engine initial><shard>`. */
export const SEED_SLOTS = ['c', 'w'].flatMap((engine) => [1, 2, 3, 4, 5, 6, 7, 8].map((shard) => `${engine}${shard}`));
export const SEED_PASSWORD_ENV = 'MOSS_SUITE_PASSWORD';
const ROWS_PER_STATEMENT = 100;
const TOKEN = /^s\d{1,20}-\d{1,4}$/;
const HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

/**
 * This run's seed token, from the workflow run id and attempt.
 * @param {string} runId
 * @param {string} attempt
 */
export function seedToken(runId, attempt) {
  const token = `s${runId}-${attempt}`;
  if (!TOKEN.test(token)) throw new Error(`a seed token needs a numeric run id and attempt, got ${runId} ${attempt}`);
  return token;
}

/**
 * @param {string} token
 * @param {string} slots
 * @param {number} k
 */
export function seedEmail(token, slots, k) {
  return `mm-${token}-${slots}-${k}@example.invalid`;
}

/**
 * The run's one suite password: an HMAC of the pool secret, apart from the pool's own (principals.ts).
 * @param {string} secret
 * @param {string} token
 */
export function suitePassword(secret, token) {
  if (!secret || secret.length < 32) throw new Error('the pool secret must be at least 32 characters');
  return createHmac('sha256', secret).update(`moss-multi staging suite ${token}`).digest('base64url');
}

/**
 * better-auth's own password hash (apps/web's better-auth), so its sign-in verifies the seeded account.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function seedHash(password) {
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { hashPassword } = await import(pathToFileURL(require.resolve('better-auth/crypto')).href);
  return hashPassword(password);
}

/** @param {string} value */
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * A user and a credential account per slot, as better-auth's sign-up writes them; the home vault heals on first use.
 * @param {{ token: string, slots: string[], perShard: number, hash: string, now: number, newId?: () => string }} options
 */
export function seedSql({ token, slots, perShard, hash, now, newId = () => randomBytes(16).toString('hex') }) {
  if (!TOKEN.test(token)) throw new Error('bad seed token');
  if (!HASH.test(hash)) throw new Error('the password hash is not better-auth scrypt hex');
  /** @type {string[]} */
  const users = [];
  /** @type {string[]} */
  const accounts = [];
  for (const slot of slots) {
    if (!SEED_SLOTS.includes(slot)) throw new Error(`unknown slots ${slot}`);
    for (let k = 0; k < perShard; k += 1) {
      const userId = newId();
      const accountId = newId();
      users.push(`(${quote(userId)}, ${quote(`Seed ${slot}-${k}`)}, ${quote(seedEmail(token, slot, k))}, 0, NULL, ${now}, ${now})`);
      accounts.push(`(${quote(accountId)}, ${quote(userId)}, 'credential', ${quote(userId)}, ${quote(hash)}, ${now}, ${now})`);
    }
  }
  /** @type {string[]} */
  const statements = [];
  /** @param {string[]} rows @param {string} head */
  const batch = (rows, head) => {
    for (let at = 0; at < rows.length; at += ROWS_PER_STATEMENT) statements.push(`${head} VALUES\n${rows.slice(at, at + ROWS_PER_STATEMENT).join(',\n')};`);
  };
  batch(users, 'INSERT INTO user (id, name, email, email_verified, image, created_at, updated_at)');
  batch(accounts, 'INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)');
  return `${statements.join('\n')}\n`;
}

/**
 * The next unclaimed slot under `dir` (one file each, created exclusively, so processes never share one), or null.
 * @param {string} dir
 * @param {number} count
 * @returns {number | null}
 */
export function claimSlot(dir, count) {
  mkdirSync(dir, { recursive: true });
  for (let k = 0; k < count; k += 1) {
    try {
      closeSync(openSync(join(dir, String(k)), 'wx'));
      return k;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    }
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  /** @param {string} name */
  const flag = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  try {
    const [mode, out] = args;
    if (mode === 'token') {
      console.log(seedToken(args[1], args[2]));
    } else if (mode === 'password') {
      process.stdout.write(suitePassword(process.env.CANARY_POOL_SECRET ?? '', flag('--token') ?? ''));
    } else if (mode === 'sql' && out) {
      const token = flag('--token') ?? '';
      const hash = await seedHash(suitePassword(process.env.CANARY_POOL_SECRET ?? '', token));
      writeFileSync(out, seedSql({ token, slots: SEED_SLOTS, perShard: SEED_PER_SHARD, hash, now: Date.now() }), { mode: 0o600 });
      console.log(`seed: ${SEED_SLOTS.length * SEED_PER_SHARD} suite principals for ${token} (${SEED_PER_SHARD} per shard)`);
    } else {
      throw new Error('usage: seed.mjs sql OUT.sql --token TOKEN | password --token TOKEN | token RUN_ID RUN_ATTEMPT');
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
